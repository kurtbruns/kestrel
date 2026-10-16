import { createExecutionContext, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import { isHumanAllowed, principalFromClaims } from "../src/auth/access";
import { DEV_TOKEN_ID, mintDevToken, verifyDevToken } from "../src/auth/dev_token";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import type { Principal, RequestContext } from "../src/router";
import * as settingsRoutes from "../src/routes/settings";
import { NOT_CONNECTED_DEPLOY, SES_DEPLOY } from "./support/deploy";
import { adminAuth, base, DEV_SECRET, readJson } from "./support/http";
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

  it("reads a common_name as a service token named by its Client ID, logging claim names only", () => {
    const lines = logged();
    const payload = { common_name: CLIENT_ID, sub: "", iss: "https://team", aud: ["aud-tag"] };
    expect(principalFromClaims(payload, ["you@example.com"])).toEqual({
      kind: "service",
      tokenId: CLIENT_ID,
      via: "access",
    });
    expect(lines()).toEqual([
      expect.objectContaining({
        event: "auth.service",
        level: "info",
        claims: "aud,common_name,iss,sub",
      }),
    ]);
    expect(JSON.stringify(lines())).not.toContain(CLIENT_ID);
  });

  it("still admits a token with neither as an anonymous service, and warns with its claim names", () => {
    const lines = logged();
    expect(principalFromClaims({ sub: "device-7", iss: "https://team" }, undefined)).toEqual({
      kind: "service",
      via: "access",
    });
    expect(lines()).toEqual([
      expect.objectContaining({ event: "auth.unidentified", level: "warn", claims: "iss,sub" }),
    ]);
    expect(JSON.stringify(lines())).not.toContain("device-7");
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
      principal: { kind: "human", email: "human@example.com" },
      auth: { mode: "dev" },
    });
  });

  it("admits a service dev token (200) with no email", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`, {
      headers: await adminAuth({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principal: { kind: "service", tokenId: DEV_TOKEN_ID },
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
// Under a configured Access, or in local development, a 401 says nothing more.
describe("the admin 401 says when no Access is configured", () => {
  const ACCESS = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" };

  it("names access_not_configured on a deployment with no Access, and nothing else", async () => {
    // Not connected is the newcomer's case, right after Deploy; a real provider is the same.
    for (const [name, vars] of Object.entries({ NOT_CONNECTED_DEPLOY, SES_DEPLOY })) {
      for (const path of ["/api/whoami", "/api/settings", "/api/posts"]) {
        const res = await fetchWith(vars, path);
        expect(res.status, `${name} ${path}`).toBe(401);
        expect(await res.json(), `${name} ${path}`).toEqual({
          error: "unauthorized",
          reason: "access_not_configured",
        });
      }
    }
    // A credential the deployment can't honor is answered the same way: there is no door.
    const token = await mintDevToken(DEV_SECRET, { email: "human@example.com" });
    const bearer = await fetchWith(SES_DEPLOY, "/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await bearer.json()).toEqual({ error: "unauthorized", reason: "access_not_configured" });
  });

  it("stays a plain 401 once Access is configured", async () => {
    const res = await fetchWith({ ...SES_DEPLOY, ...ACCESS }, "/api/whoami");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("stays a plain 401 in a dev-shaped env, with or without the dev secret", async () => {
    const res = await SELF.fetch(`${base}/api/whoami`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // Local dev missing `.dev.vars`: Access is not what it lacks.
    const noSecret = await fetchWith({ DEV_AUTH_SECRET: "" }, "/api/whoami");
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toEqual({ error: "unauthorized" });
  });
});

// `auth.mode` says how this request signed in, read off the principal the request resolved
// to, so it is right by construction rather than by what happens to be configured (SPEC §11).
describe("the auth mode follows how the request signed in", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An Access deployment whose team serves a key this spec holds, so a request can carry
   *  an assertion the app verifies for real. A team domain of its own per test, since the
   *  app caches a team's keys for the life of the isolate. `stored` is the team domain as
   *  the operator entered it, which may carry a scheme or a trailing slash. */
  async function accessDeployment(stored: (team: string) => string = (team) => team) {
    const team = `team-${crypto.randomUUID()}.cloudflareaccess.com`;
    const vars = { ACCESS_TEAM_DOMAIN: stored(team), ACCESS_AUD: "aud-tag" };
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `https://${team}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      return realFetch(input, init);
    });
    const assertion = async (claims: { email?: string; common_name?: string }) => ({
      "Cf-Access-Jwt-Assertion": await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(`https://${team}`)
        .setAudience("aud-tag")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
    });
    return { vars, assertion };
  }

  it("reports access for a request signed in through Access, in whoami and the settings reflection", async () => {
    const { vars, assertion } = await accessDeployment();
    const headers = await assertion({ email: "you@example.com" });
    const who = await fetchWith(vars, "/api/whoami", { headers });
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({
      principal: { kind: "human", email: "you@example.com" },
      auth: { mode: "access" },
    });
    const settings = await readJson(await fetchWith(vars, "/api/settings", { headers }));
    expect(settings.deployment.authMode).toBe("access");
    // A service token signs in through Access too, named by its Client ID.
    const service = await fetchWith(vars, "/api/whoami", {
      headers: await assertion({ common_name: "e367c0ffee5eb4.access" }),
    });
    expect(await service.json()).toEqual({
      principal: { kind: "service", tokenId: "e367c0ffee5eb4.access" },
      auth: { mode: "access" },
    });
    // One with neither claim is still admitted for now, with no name to give.
    const unidentified = await fetchWith(vars, "/api/whoami", { headers: await assertion({}) });
    expect(await unidentified.json()).toEqual({
      principal: { kind: "service" },
      auth: { mode: "access" },
    });
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
    expect((await readJson(res)).deployment.authMode).toBe("dev");
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
    expect(settings.deployment.authMode).toBe("dev");
  });
});
