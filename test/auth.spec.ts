import { createExecutionContext, SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import { isHumanAllowed, principalFromClaims } from "../src/auth/access";
import { DEV_TOKEN_ID, mintDevToken, verifyDevToken } from "../src/auth/dev_token";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import type { Principal, RequestContext } from "../src/router";
import * as settingsRoutes from "../src/routes/settings";
import { accessDeployment } from "./support/access";
import { NOT_CONNECTED_DEPLOY, SES_DEPLOY } from "./support/deploy";
import { adminAuth, base, DEV_SECRET, readJson } from "./support/http";
import { logged } from "./support/log";
import { fetchWith, withVars } from "./support/worker_env";

describe("Access admin allowlist", () => {
  it("admits anyone when no allowlist is configured", () => {
    expect(isHumanAllowed("anyone@example.com", undefined)).toBe(true);
    expect(isHumanAllowed("anyone@example.com", [])).toBe(true);
  });
  it("admits only allowlisted emails (case-insensitive) when configured", () => {
    const allow = ["you@example.com", "team@example.com"];
    expect(isHumanAllowed("YOU@example.com", allow)).toBe(true);
    expect(isHumanAllowed("intruder@example.com", allow)).toBe(false);
  });
});

describe("Access claims to a principal", () => {
  const CLIENT_ID = "e367c0ffee5eb4.access";
  // Every line the mapping logs, parsed, from whichever console method its level used.
  const logged = () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    return () => spies.flatMap((s) => s.mock.calls.map((call) => JSON.parse(String(call[0]))));
  };
  afterEach(() => vi.restoreAllMocks());

  it("reads an email as a person, checked against the allowlist, and logs nothing", () => {
    const lines = logged();
    expect(principalFromClaims({ email: "you@example.com", sub: "u1" }, undefined)).toEqual({
      kind: "human",
      email: "you@example.com",
      via: "access",
    });
    expect(principalFromClaims({ email: "intruder@example.com" }, ["you@example.com"])).toBeNull();
    expect(lines()).toEqual([]);
  });

  it("reads a common_name as a service token named by its Client ID, logging nothing (SPEC §12)", () => {
    const lines = logged();
    const payload = { common_name: CLIENT_ID, sub: "", iss: "https://team", aud: ["aud-tag"] };
    expect(principalFromClaims(payload, ["you@example.com"])).toEqual({
      kind: "service",
      tokenId: CLIENT_ID,
      via: "access",
    });
    expect(lines()).toEqual([]);
  });

  it("refuses a token with neither as unidentified, and warns with its claim names only (SPEC §11)", () => {
    const lines = logged();
    expect(principalFromClaims({ sub: "device-7", iss: "https://team" }, undefined)).toBe(
      "access_unidentified",
    );
    expect(lines()).toEqual([
      expect.objectContaining({ event: "auth.unidentified", level: "warn", claims: "iss,sub" }),
    ]);
    expect(JSON.stringify(lines())).not.toContain("device-7");
  });

  it("reads an empty claim as no claim: an empty common_name names no token, an empty email no person (SPEC §11)", () => {
    const lines = logged();
    expect(principalFromClaims({ common_name: "", sub: "" }, undefined)).toBe(
      "access_unidentified",
    );
    expect(principalFromClaims({ email: "", common_name: "x.access" }, undefined)).toEqual({
      kind: "service",
      tokenId: "x.access",
      via: "access",
    });
    expect(lines()).toEqual([
      expect.objectContaining({ event: "auth.unidentified", claims: "common_name,sub" }),
    ]);
  });
});

describe("auth on the admin surface", () => {
  it("rejects /api/whoami with no token (401)", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret (401)", async () => {
    const token = await mintDevToken("some-other-secret", { email: "x@example.com" });
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token signed with the right secret (401)", async () => {
    // Signed exactly as mintDevToken signs, but its expiry an hour past.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: "human@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("kestrel-dev")
      .setAudience("kestrel-admin")
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(new TextEncoder().encode(DEV_SECRET));
    expect(await verifyDevToken(token, DEV_SECRET)).toBeNull();
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid token whose claims were edited after signing (401)", async () => {
    const token = await mintDevToken(DEV_SECRET, {});
    const [header, payload, signature] = token.split(".") as [string, string, string];
    // Promote the service token to a human by adding an email the signature never covered.
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const forged = btoa(JSON.stringify({ ...claims, email: "intruder@example.com" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${header}.${forged}.${signature}`;
    expect(await verifyDevToken(tampered, DEV_SECRET)).toBeNull();
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it("admits a human dev token (200) and reports the principal + mode", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: await adminAuth({ email: "human@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principal: { kind: "human", email: "human@example.com", client: null },
      auth: { mode: "dev" },
    });
  });

  it("admits a service dev token (200) with no email", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: await adminAuth({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principal: { kind: "service", token_id: DEV_TOKEN_ID, client: null },
      auth: { mode: "dev" },
    });
  });

  it("keeps /health public (200, no token)", async () => {
    const res = await SELF.fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe("dev-token bootstrap endpoint", () => {
  it("mints a working human token by default", async () => {
    const res = await SELF.fetch(`${base}/api/dev/token`);
    expect(res.status).toBe(200);
    const { token, kind } = (await res.json()) as { token: string; kind: string };
    expect(kind).toBe("human");
    const who = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(who.status).toBe(200);
  });

  it("mints a working service token when asked", async () => {
    const res = await SELF.fetch(`${base}/api/dev/token?kind=service`);
    expect(res.status).toBe(200);
    const { token, kind } = (await res.json()) as { token: string; kind: string };
    expect(kind).toBe("service");
    // The token itself is a service principal, not a human one labeled "service".
    const who = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ principal: { kind: "service" } });
  });
});

describe("dev credential is inert in a deployed-shaped env", () => {
  const deployed = {
    ...SES_DEPLOY,
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud-tag",
    DEV_AUTH_SECRET: DEV_SECRET,
    APP_ORIGIN: "https://newsletter.birds.example",
    ARCHIVE_BASE_PATH: "/archive",
  } as unknown as AppEnv;

  it("does not resolve devAuthSecret when provider is real and Access is configured", () => {
    expect(getConfig(deployed).devAuthSecret).toBeUndefined();
  });

  // Pins the AND semantics: a real provider with Access not yet configured must
  // still drop the secret. This case would leak under an accidental `||`.
  it("does not resolve devAuthSecret for a real provider even if Access is unset", () => {
    const halfDeployed = {
      ...deployed,
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    } as unknown as AppEnv;
    expect(getConfig(halfDeployed).devAuthSecret).toBeUndefined();
  });

  it("resolves devAuthSecret only in a dev-shaped env (fake + no Access + loopback origin)", () => {
    const dev = {
      ...deployed,
      PROVIDER: "fake",
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
      APP_ORIGIN: "http://localhost:8787",
    } as unknown as AppEnv;
    expect(getConfig(dev).devAuthSecret).toBe(DEV_SECRET);
    const loopback = { ...dev, APP_ORIGIN: "http://127.0.0.1:8787" } as unknown as AppEnv;
    expect(getConfig(loopback).devAuthSecret).toBe(DEV_SECRET);
  });

  // A fake, Access-less deploy given its real hostname, with `.dev.vars` uploaded as
  // secrets: only the origin says it is not this machine. Without that check the public
  // token route would hand out admin tokens.
  it("does not resolve devAuthSecret for the fake transport served from a public origin", () => {
    const pushedDev = {
      ...deployed,
      PROVIDER: "fake",
      // The one way the fake runs on a public origin: a demo opting in (SPEC §9).
      ALLOW_FAKE_PROVIDER: "true",
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    } as unknown as AppEnv;
    expect(getConfig(pushedDev).devAuthSecret).toBeUndefined();
    expect(getConfig(pushedDev).devMode).toBe(false);
  });

  it("still verifies a token in isolation (guard lives in config, not the verifier)", async () => {
    const token = await mintDevToken(DEV_SECRET, { email: "human@example.com" });
    expect(await verifyDevToken(token, DEV_SECRET)).toEqual({
      kind: "human",
      email: "human@example.com",
      via: "dev",
    });
  });
});

// Before Access is set up on a deployment, no admin request can authenticate, and the 401
// says so, so the editor can show that state rather than a session that ended (SPEC §11).
// Under a configured Access a 401 says nothing more; on a local dev server it offers a dev token.
// Every 401 carries words to show, as any refusal does; one signing in again can't fix says why.
const PLAIN_401 = { error: "unauthorized", message: expect.stringMatching(/^Sign in: /) };
const DEV_401 = { ...PLAIN_401, dev_token_available: true };
const NOT_CONFIGURED = {
  error: "unauthorized",
  reason: "access_not_configured",
  message: expect.stringContaining("No Cloudflare Access is set up"),
};

describe("the admin 401 says when no Access is configured", () => {
  const ACCESS = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" };

  it("names access_not_configured on a deployment with no Access, and nothing else", async () => {
    // Not connected is the newcomer's case, right after Deploy; a real provider is the same.
    for (const [name, vars] of Object.entries({ NOT_CONNECTED_DEPLOY, SES_DEPLOY })) {
      for (const path of ["/api/whoami", "/api/settings", "/api/posts"]) {
        const res = await fetchWith(vars, path);
        expect(res.status, `${name} ${path}`).toBe(401);
        expect(await res.json(), `${name} ${path}`).toEqual(NOT_CONFIGURED);
      }
    }
    // A credential the deployment can't honor is answered the same way: there is no door.
    const token = await mintDevToken(DEV_SECRET, { email: "human@example.com" });
    const bearer = await fetchWith(SES_DEPLOY, "/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await bearer.json()).toEqual(NOT_CONFIGURED);
  });

  it("stays a plain 401 once Access is configured", async () => {
    const res = await fetchWith({ ...SES_DEPLOY, ...ACCESS }, "/api/whoami");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(PLAIN_401);
  });

  it("offers a dev token on a local dev server, with no credential or a dead one (SPEC §11)", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(DEV_401);
    const stale = await SELF.fetch(`${base}/api/whoami`, {
      headers: { Authorization: "Bearer stale" },
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual(DEV_401);
    // The offer stands because the route is there to take it.
    expect((await SELF.fetch(`${base}/api/dev/token`)).status).toBe(200);
  });

  it("offers none where the dev routes are absent (SPEC §11)", async () => {
    // Local dev missing `.dev.vars`: dev-shaped, but with no secret, so no route to mint from.
    const noSecret = await fetchWith({ DEV_AUTH_SECRET: "" }, "/api/whoami");
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toEqual(PLAIN_401);
    expect((await fetchWith({ DEV_AUTH_SECRET: "" }, "/api/dev/token")).status).toBe(404);
  });
});

// `auth.mode` says how this request signed in, read off the principal the request resolved
// to, so it is right by construction rather than by what happens to be configured (SPEC §11).
describe("the auth mode follows how the request signed in", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports access for a request signed in through Access, in whoami and the settings reflection", async () => {
    const { vars, assertion } = await accessDeployment();
    const headers = await assertion({ email: "you@example.com" });
    const who = await fetchWith(vars, "/api/whoami", { headers });
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({
      principal: { kind: "human", email: "you@example.com", client: null },
      auth: { mode: "access" },
    });
    const settings = await readJson(await fetchWith(vars, "/api/settings", { headers }));
    expect(settings.deployment.auth_mode).toBe("access");
    // A service token signs in through Access too, named by its Client ID.
    const service = await fetchWith(vars, "/api/whoami", {
      headers: await assertion({ common_name: "e367c0ffee5eb4.access" }),
    });
    expect(await service.json()).toEqual({
      principal: { kind: "service", token_id: "e367c0ffee5eb4.access", client: null },
      auth: { mode: "access" },
    });
    // One with neither claim is refused, saying why: some other kind of Access policy let
    // it in, so signing in the same way again can't help.
    const unidentified = await fetchWith(vars, "/api/whoami", { headers: await assertion({}) });
    expect(unidentified.status).toBe(401);
    expect(unidentified.headers.get("WWW-Authenticate")).toBe('Bearer realm="kestrel"');
    expect(await unidentified.json()).toEqual({
      error: "unauthorized",
      reason: "access_unidentified",
      message: expect.stringContaining("neither an email address nor a service token"),
    });
    // The MCP connector's one route says the same, so its client can show why.
    const mcp = await fetchWith(vars, "/api/mcp", {
      method: "POST",
      headers: { ...(await assertion({})), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(401);
    expect(await mcp.json()).toMatchObject({
      error: "unauthorized",
      reason: "access_unidentified",
    });
    // A person the allowlist leaves out is a plain 401, with nothing to explain.
    const outside = await fetchWith(
      { ...vars, ACCESS_ALLOWED_EMAILS: "you@example.com" },
      "/api/whoami",
      {
        headers: await assertion({ email: "intruder@example.com" }),
      },
    );
    expect(outside.status).toBe(401);
    expect(await outside.json()).toEqual(PLAIN_401);
  });

  // Access issues for the bare host, so a team domain stored as a URL must still verify.
  it("verifies a sign-in when the team domain was stored with its scheme and a trailing slash", async () => {
    const { vars, assertion } = await accessDeployment((team) => `https://${team}/`);
    const who = await fetchWith(vars, "/api/whoami", {
      headers: await assertion({ email: "you@example.com" }),
    });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      principal: { kind: "human", email: "you@example.com" },
    });
  });

  it("reports dev for the dev token in the settings reflection", async () => {
    const res = await SELF.fetch(`${base}/api/settings`, { headers: await adminAuth() });
    expect((await readJson(res)).deployment.auth_mode).toBe("dev");
  });

  // Config and principal agree on every door that exists today, so the only way to show which
  // one a handler reads is to hand it a principal that disagrees with its config.
  it("reads the principal, not the Access config", async () => {
    const e = withVars({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
    const config = getConfig(e);
    const principal: Principal = { kind: "human", email: "you@example.com", via: "dev" };
    const context = (path: string) => {
      const req = new Request(`${base}${path}`);
      return {
        req,
        env: e,
        ctx: createExecutionContext(),
        url: new URL(req.url),
        params: {},
        config,
        principal,
      } as unknown as RequestContext;
    };
    const whoami = createRouter(config).routes.find((r) => r.def.path === "/api/whoami")!;
    const who = await whoami.def.handler(context("/api/whoami"));
    expect(await who.json()).toMatchObject({ auth: { mode: "dev" } });
    const settings = await readJson(await settingsRoutes.get(context("/api/settings")));
    expect(settings.deployment.auth_mode).toBe("dev");
  });
});

// A sign-in the app refuses says why in the log, by a reason and nothing of the token, so a
// locked-out operator can read the cause (SPEC §11, §12).
describe("a refused Access sign-in says why in the log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const refusals = (warn: ReturnType<typeof vi.spyOn>) =>
    logged(warn).filter((line) => line.event === "auth.refused");

  it("answers 401 to a token for another audience, and logs auth.refused with reason audience (SPEC §11)", async () => {
    const { vars, assertion } = await accessDeployment();
    const warn = vi.spyOn(console, "warn");
    const res = await fetchWith(vars, "/api/whoami", {
      headers: await assertion({ email: "you@example.com" }, { audience: "another-app" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(PLAIN_401);
    expect(refusals(warn)).toEqual([
      { event: "auth.refused", level: "warn", run: expect.any(String), reason: "audience" },
    ]);
  });

  it("answers 503 with retry_after when the team's keys can't be fetched, and logs reason jwks_unreachable (SPEC §11)", async () => {
    // A sign-in that would verify, on a deployment whose team domain serves no keys.
    const { vars, assertion } = await accessDeployment();
    const person = await assertion({ email: "you@example.com" });
    const service = await assertion({ common_name: "e367c0ffee5eb4.access" });
    const team = `team-${crypto.randomUUID()}.cloudflareaccess.com`;
    for (const [answer, keys] of Object.entries({
      "no answer": () => Promise.reject(new TypeError("Network connection lost.")),
      "a 404": () => Promise.resolve(new Response("not found", { status: 404 })),
      "a timeout": () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      "a 200 that isn't a key set": () => Promise.resolve(Response.json({ keys: "none" })),
      // A program's sign-in is answered the same way as a person's.
      "no answer to a service token": () => Promise.reject(new TypeError("Network down.")),
    })) {
      const headers = answer.endsWith("service token") ? service : person;
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url === `https://${team}/cdn-cgi/access/certs` ? keys() : realFetch(input, init);
      });
      const warn = vi.spyOn(console, "warn");
      const before = Date.now();
      const res = await fetchWith({ ...vars, ACCESS_TEAM_DOMAIN: team }, "/api/whoami", {
        headers,
      });
      expect(res.status, answer).toBe(503);
      expect(res.headers.get("Retry-After"), answer).toBe("30");
      const body = await readJson(res);
      expect(body, answer).toEqual({
        error: "access_unreachable",
        message: expect.stringContaining("couldn't fetch Cloudflare Access's signing keys"),
        retry_after: expect.any(Number),
      });
      expect(body.retry_after, answer).toBeGreaterThanOrEqual(before + 30_000);
      expect(body.retry_after, answer).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(refusals(warn), answer).toEqual([
        {
          event: "auth.refused",
          level: "warn",
          run: expect.any(String),
          reason: "jwks_unreachable",
        },
      ]);
      vi.restoreAllMocks();
    }
  });

  it("names an expired, a not-yet-valid, a foreign-issuer, a wrongly signed, and a malformed token each by its reason, with a 401 and nothing of the token (SPEC §12)", async () => {
    const { vars, assertion } = await accessDeployment();
    // A real assertion with its signature replaced by another of the same length.
    const good = (await assertion({ email: "you@example.com" }))["Cf-Access-Jwt-Assertion"];
    const [header, payload, signature] = good.split(".") as [string, string, string];
    const forged = `${header}.${payload}.${"A".repeat(signature.length)}`;
    const hour = Math.floor(Date.now() / 1000) - 3600;
    const tokens = {
      expired: await assertion({ email: "you@example.com" }, { expires: hour }),
      not_yet_valid: await assertion({ email: "you@example.com" }, { notBefore: hour + 7200 }),
      issuer: await assertion(
        { email: "you@example.com" },
        { issuer: "https://elsewhere.example" },
      ),
      signature: { "Cf-Access-Jwt-Assertion": forged },
      // Signed under a key id the team doesn't publish, as another team's token is.
      unknown_key: await assertion({ email: "you@example.com" }, { kid: "k2" }),
      malformed: { "Cf-Access-Jwt-Assertion": "not-a-token" },
    };
    const warn = vi.spyOn(console, "warn");
    for (const [reason, headers] of Object.entries(tokens)) {
      const res = await fetchWith(vars, "/api/whoami", { headers });
      expect(res.status, reason).toBe(401);
      expect(await res.json(), reason).toEqual(PLAIN_401);
    }
    expect(refusals(warn).map((line) => line.reason)).toEqual(
      Object.keys(tokens).map((reason) => (reason === "unknown_key" ? "signature" : reason)),
    );
    const text = JSON.stringify(logged(warn));
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("aud-tag");
  });

  it("logs reason not_allowed, without the email, for a verified person the allowlist leaves out, and nothing more (SPEC §12)", async () => {
    const { vars, assertion } = await accessDeployment();
    const warn = vi.spyOn(console, "warn");
    const res = await fetchWith(
      { ...vars, ACCESS_ALLOWED_EMAILS: "you@example.com" },
      "/api/whoami",
      { headers: await assertion({ email: "intruder@example.com" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(PLAIN_401);
    // The one line: every other field would be the token's.
    expect(logged(warn)).toEqual([
      { event: "auth.refused", level: "warn", run: expect.any(String), reason: "not_allowed" },
    ]);
  });

  it("logs auth.unidentified alone, never auth.refused too, for a sign-in that names no one (SPEC §11)", async () => {
    const { vars, assertion } = await accessDeployment();
    const warn = vi.spyOn(console, "warn");
    const res = await fetchWith(vars, "/api/whoami", { headers: await assertion({}) });
    expect(res.status).toBe(401);
    expect(logged(warn).map((line) => line.event)).toEqual(["auth.unidentified"]);
  });

  it("logs nothing for a request with no Access assertion, or one that verifies", async () => {
    const { vars, assertion } = await accessDeployment();
    const warn = vi.spyOn(console, "warn");
    expect((await fetchWith(vars, "/api/whoami")).status).toBe(401);
    const ok = await fetchWith(vars, "/api/whoami", {
      headers: await assertion({ email: "you@example.com" }),
    });
    expect(ok.status).toBe(200);
    expect(refusals(warn)).toEqual([]);
  });
});
