import { createExecutionContext, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import { isHumanAllowed } from "../src/auth/access";
import { mintDevToken, verifyDevToken } from "../src/auth/dev_token";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import type { Principal, RequestContext } from "../src/router";
import * as settingsRoutes from "../src/routes/settings";
import { SES_DEPLOY } from "./support/deploy";
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
    expect(await res.json()).toEqual({ principal: { kind: "service" }, auth: { mode: "dev" } });
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
    const assertion = async (claims: { email?: string }) => ({
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
    // A service token signs in through Access too.
    const service = await fetchWith(vars, "/api/whoami", { headers: await assertion({}) });
    expect(await service.json()).toEqual({
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
