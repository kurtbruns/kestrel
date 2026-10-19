/*
 * The sign-in `kestrel login` makes and `kestrel api` uses (SPEC §11): which instance a URL
 * names, where the sign-in is kept and who can read it, when its token is refreshed, and the
 * loopback callback that receives the browser's approval. Access itself is stubbed at fetch;
 * the flow against a real Access application is checked by hand on a test instance.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, chooseInstance, parseApiArgs, signedInFetch } from "../../cli/api.mjs";
import {
  configDir,
  credentialsFile,
  readSignIn,
  readSignIns,
  writeSignIn,
} from "../../cli/credentials.mjs";
import {
  authorizeUrl,
  discover,
  instanceOrigin,
  listenForCode,
  needsRefresh,
  pkcePair,
  resourceMetadataUrl,
  SignInError,
  tokenFields,
} from "../../cli/oauth.mjs";

const ORIGIN = "https://news.example.com";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-signin-"));
  vi.stubEnv("KESTREL_CONFIG_DIR", dir);
  vi.stubEnv("KESTREL_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** A stored sign-in whose access token expires `inMs` from now. */
function stored(inMs, extra = {}) {
  return {
    resource: `${ORIGIN}/api/whoami`,
    issuer: "https://team.cloudflareaccess.com",
    token_endpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
    registration_endpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
    client_id: "client-1",
    redirect_uri: "http://127.0.0.1:50000/callback",
    access_token: "oauth:old",
    expires_at: Date.now() + inMs,
    refresh_token: "refresh-1",
    ...extra,
  };
}

/** Stub fetch with a handler per call, in order; records each request. */
function stubFetch(...replies) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return reply(String(url), init);
  });
  return calls;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("which instance a URL names", () => {
  it("is the origin, so a path or trailing slash names the same instance", () => {
    expect(instanceOrigin("https://news.example.com/dashboard/")).toBe(ORIGIN);
    expect(instanceOrigin("news.example.com")).toBe(ORIGIN);
  });

  it("refuses plain http except on this computer, since a token would cross the network in the clear", () => {
    expect(() => instanceOrigin("http://news.example.com")).toThrow(SignInError);
    expect(instanceOrigin("http://localhost:8787/api")).toBe("http://localhost:8787");
  });

  it("goes to --url, then KESTREL_URL, then the one instance signed in to, and never guesses among several", () => {
    const one = { [ORIGIN]: {} };
    const two = { [ORIGIN]: {}, "https://b.example.com": {} };
    expect(chooseInstance({ url: "https://b.example.com/x", env: {}, signIns: one })).toBe(
      "https://b.example.com",
    );
    expect(chooseInstance({ env: { KESTREL_URL: "https://b.example.com" }, signIns: one })).toBe(
      "https://b.example.com",
    );
    expect(chooseInstance({ env: {}, signIns: one })).toBe(ORIGIN);
    expect(() => chooseInstance({ env: {}, signIns: two })).toThrow(/Name one with --url/);
    expect(() => chooseInstance({ env: {}, signIns: {} })).toThrow(/kestrel login/);
  });
});

describe("where a sign-in is kept", () => {
  it("is the person's user config, not the folder a command runs in", () => {
    const env = { XDG_CONFIG_HOME: "/home/me/.config" };
    expect(configDir(env, "linux")).toBe("/home/me/.config/kestrel");
    expect(configDir({ APPDATA: "C:\\Users\\me\\AppData" }, "win32")).toBe(
      join("C:\\Users\\me\\AppData", "kestrel"),
    );
    expect(configDir({ KESTREL_CONFIG_DIR: "/elsewhere" }, "linux")).toBe("/elsewhere");
  });

  it("is readable by its owner alone, keyed by origin, and forgetting one leaves the others", () => {
    writeSignIn(ORIGIN, stored(60_000));
    writeSignIn("https://b.example.com", stored(60_000, { client_id: "client-b" }));
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(readSignIn(ORIGIN)?.client_id).toBe("client-1");
    writeSignIn(ORIGIN, undefined);
    expect(Object.keys(readSignIns())).toEqual(["https://b.example.com"]);
  });
});

describe("the OAuth steps", () => {
  it("finds the authorization server from Access's 401 on a protected path, never the public root", async () => {
    const calls = stubFetch(
      () =>
        json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/cloudflare-access-protected-resource/api/whoami"`,
        }),
      () =>
        json({
          resource: `${ORIGIN}/api/whoami`,
          authorization_servers: ["https://team.cloudflareaccess.com"],
        }),
      () =>
        json({
          authorization_endpoint: "https://team.cloudflareaccess.com/authorize",
          token_endpoint: "https://team.cloudflareaccess.com/token",
          registration_endpoint: "https://team.cloudflareaccess.com/register",
        }),
    );
    const found = await discover(ORIGIN);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/whoami`);
    expect(found).toEqual({
      resource: `${ORIGIN}/api/whoami`,
      issuer: "https://team.cloudflareaccess.com",
      authorization_endpoint: "https://team.cloudflareaccess.com/authorize",
      token_endpoint: "https://team.cloudflareaccess.com/token",
      registration_endpoint: "https://team.cloudflareaccess.com/register",
      revocation_endpoint: undefined,
    });
  });

  it("says the instance offers no sign-in when Access answers without OAuth metadata", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "/login" } }));
    await expect(discover(ORIGIN)).rejects.toThrow(/doesn't offer a sign-in for programs/);
  });

  it("reads the resource metadata URL from a WWW-Authenticate header", () => {
    expect(
      resourceMetadataUrl('Bearer realm="OAuth", resource_metadata="https://x.example/m"'),
    ).toBe("https://x.example/m");
    expect(resourceMetadataUrl('Bearer realm="kestrel"')).toBeUndefined();
  });

  it("asks for a code with PKCE (S256) and names the protected resource (RFC 8707)", async () => {
    const { verifier, challenge } = pkcePair();
    const { createHash } = await import("node:crypto");
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(
      authorizeUrl({
        endpoint: "https://team.cloudflareaccess.com/authorize",
        clientId: "c",
        redirectUri: "http://127.0.0.1:5/callback",
        challenge,
        state: "s",
        resource: `${ORIGIN}/api/whoami`,
      }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(`${ORIGIN}/api/whoami`);
  });

  it("refreshes a token about to expire, and keeps the refresh token when none comes back", () => {
    const now = 1_000_000;
    expect(needsRefresh({ access_token: "a", expires_at: now + 5 * 60_000 }, now)).toBe(false);
    expect(needsRefresh({ access_token: "a", expires_at: now + 30_000 }, now)).toBe(true);
    expect(
      tokenFields({ access_token: "b", expires_in: 900 }, { refresh_token: "r" }, now),
    ).toEqual({ access_token: "b", expires_at: now + 900_000, refresh_token: "r" });
  });
});

describe("a call as the signed-in person", () => {
  it("refreshes an expiring token before sending it, and stores what comes back", async () => {
    writeSignIn(ORIGIN, stored(10_000));
    const calls = stubFetch(() =>
      json({ access_token: "oauth:new", expires_in: 900, refresh_token: "refresh-2" }),
    );
    expect(await accessToken(ORIGIN)).toBe("oauth:new");
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("resource")).toBe(`${ORIGIN}/api/whoami`);
    expect(readSignIn(ORIGIN)?.refresh_token).toBe("refresh-2");
  });

  it("asks the person to sign in again once the grant has ended", async () => {
    writeSignIn(ORIGIN, stored(-1));
    stubFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(accessToken(ORIGIN)).rejects.toThrow(
      `Your sign-in to ${ORIGIN} has ended. Run \`npx kestrel login ${ORIGIN}\` again.`,
    );
  });

  it("names its client and retries once after a refresh when Access refuses the token, but not on the app's own 401", async () => {
    writeSignIn(ORIGIN, stored(10 * 60_000));
    const edge401 = () =>
      json({ error: "invalid_token" }, 401, {
        "www-authenticate": `Bearer realm="OAuth", resource_metadata="${ORIGIN}/m"`,
      });
    const calls = stubFetch(
      edge401,
      () => json({ access_token: "oauth:new", expires_in: 900 }),
      () => json({ principal: { kind: "human" } }),
    );
    const res = await signedInFetch(ORIGIN, "/api/whoami", { client: "claude-code" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.init.headers?.authorization)).toEqual([
      "Bearer oauth:old",
      undefined,
      "Bearer oauth:new",
    ]);
    expect(calls[2]?.init.headers?.["kestrel-client"]).toBe("claude-code");

    const app401 = stubFetch(() =>
      json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="kestrel"' }),
    );
    expect((await signedInFetch(ORIGIN, "/api/whoami", { client: "claude-code" })).status).toBe(
      401,
    );
    expect(app401).toHaveLength(1);
  });
});

describe("kestrel api's arguments", () => {
  it("takes a method, a path, and options in any order, with --form repeatable", () => {
    expect(
      parseApiArgs(["post", "/api/posts", "--data", '{"subject":"Hi"}', "--client=my-script"]),
    ).toEqual({
      method: "POST",
      path: "/api/posts",
      data: '{"subject":"Hi"}',
      client: "my-script",
      forms: [],
      local: false,
    });
    expect(
      parseApiArgs(["--local", "POST", "/api/x", "--form", "a=1", "--form", "file=@f.png"]).forms,
    ).toEqual(["a=1", "file=@f.png"]);
  });

  it("refuses a path without its slash, an unknown option, and a body sent two ways", () => {
    expect(() => parseApiArgs(["GET", "api/posts"])).toThrow(/starts with a slash/);
    expect(() => parseApiArgs(["GET", "/api/posts", "--verbose"])).toThrow(/unknown option/);
    expect(() => parseApiArgs(["POST", "/x", "--data", "{}", "--form", "a=1"])).toThrow(/not both/);
  });
});

describe("the loopback callback", () => {
  it("answers only the request carrying this sign-in's state, with its code", async () => {
    const listener = await listenForCode({ state: "right", timeoutMs: 5_000 });
    const base = listener.redirectUri;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(`${base}?state=wrong&code=evil`)).status).toBe(400);
    expect((await fetch(`${base}?state=right&code=good`)).status).toBe(200);
    expect(await listener.code).toBe("good");
  });

  it("rejects with Access's words when the sign-in is refused", async () => {
    const listener = await listenForCode({ state: "s", timeoutMs: 5_000 });
    const refused = expect(listener.code).rejects.toThrow(/access_denied: not allowed/);
    await fetch(
      `${listener.redirectUri}?state=s&error=access_denied&error_description=not+allowed`,
    );
    await refused;
  });
});
