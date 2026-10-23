/*
 * The sign-in `kestrel login` makes and `kestrel api` uses (SPEC §11): which instance a URL
 * names, where the sign-in is kept and who can read it, when its token is refreshed, and the
 * loopback callback that receives the browser's approval. Access itself is stubbed at fetch;
 * the flow against a real Access application is checked by hand on a test instance.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessToken,
  CLIENT_NAME_MAX,
  CLIENT_NAME_PATTERN,
  chooseInstance,
  parseApiArgs,
  signedInFetch,
} from "../../packages/kestrel/lib/api.mjs";
import {
  configDir,
  credentialsFile,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  readSignIn,
  readSignIns,
  withCredentialsLock,
  writeSignIn,
} from "../../packages/kestrel/lib/credentials.mjs";
import { signIn } from "../../packages/kestrel/lib/login.mjs";
import {
  authorizeUrl,
  discover,
  instanceOrigin,
  listenForCode,
  needsRefresh,
  pkcePair,
  refreshTokens,
  resourceMetadataUrl,
  SignInError,
  TOKEN_TIMEOUT_MS,
  tokenFields,
} from "../../packages/kestrel/lib/oauth.mjs";
import {
  CLIENT_NAME_MAX as SERVER_MAX,
  CLIENT_NAME_PATTERN as SERVER_PATTERN,
} from "../../shared/who_acted.ts";

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

  it("is readable by its owner alone, keyed by origin, and forgetting one leaves the others", async () => {
    await writeSignIn(ORIGIN, stored(60_000));
    await writeSignIn("https://b.example.com", stored(60_000, { client_id: "client-b" }));
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(readSignIn(ORIGIN)?.client_id).toBe("client-1");
    await writeSignIn(ORIGIN, undefined);
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
    await writeSignIn(ORIGIN, stored(10_000));
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
    await writeSignIn(ORIGIN, stored(-1));
    stubFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(accessToken(ORIGIN)).rejects.toThrow(
      `Your sign-in to ${ORIGIN} has ended. Run \`npx kestrel login ${ORIGIN}\` again.`,
    );
  });

  it("names its client and retries once after a refresh when Access refuses the token, but not on the app's own 401", async () => {
    await writeSignIn(ORIGIN, stored(10 * 60_000));
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
      mode: "call",
      method: "POST",
      path: "/api/posts",
      data: '{"subject":"Hi"}',
      client: "my-script",
      forms: [],
      fields: [],
      local: false,
    });
    expect(
      parseApiArgs(["--local", "POST", "/api/x", "--form", "a=1", "--form", "file=@f.png"]).forms,
    ).toEqual(["a=1", "file=@f.png"]);
  });

  // fetch trims a header value, so " editor\t" would reach the server as the editor's name.
  it("refuses to name the editor as the client, with or without whitespace around it (SPEC §7)", () => {
    for (const argv of [
      ["POST", "/api/imports/commit", "--client", "editor"],
      ["POST", "/api/imports/commit", "--client", " editor\t"],
      ["--list", "--client= editor "],
    ]) {
      expect(() => parseApiArgs(argv)).toThrow(/^--client editor is refused: only the editor/);
    }
    expect(parseApiArgs(["GET", "/api/posts", "--client", " editor-sync "]).client).toBe(
      "editor-sync",
    );
  });

  it("refuses a client name the server would refuse, as the server's rule says", () => {
    for (const name of ["Editor", "my script", "-x", "a--b", "", "a".repeat(33)]) {
      expect(() => parseApiArgs(["GET", "/api/posts", "--client", name]), name).toThrow(
        /^--client takes one short lowercase word/,
      );
    }
    expect(CLIENT_NAME_PATTERN).toBe(SERVER_PATTERN);
    expect(CLIENT_NAME_MAX).toBe(SERVER_MAX);
  });

  it("refuses a path without its slash, an unknown option, and a body sent two ways", () => {
    expect(() => parseApiArgs(["GET", "api/posts"])).toThrow(/starts with a slash/);
    expect(() => parseApiArgs(["GET", "/api/posts", "--verbose"])).toThrow(/unknown option/);
    expect(() => parseApiArgs(["POST", "/x", "--data", "{}", "--form", "a=1"])).toThrow(/one way/);
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

describe("refusing a credentials file it can't read", () => {
  it("names the file and leaves it as it is, rather than dropping the sign-ins it holds", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(credentialsFile(), '{"version":2,"instances":{}}');
    expect(() => readSignIns()).toThrow(credentialsFile());
    await expect(writeSignIn(ORIGIN, stored(60_000))).rejects.toThrow(/left as it is/);
    writeFileSync(credentialsFile(), "not json");
    expect(() => readSignIn(ORIGIN)).toThrow(credentialsFile());
  });
});

describe("refreshing side by side", () => {
  it("spends one refresh token once, however many calls need a fresh token at the same moment", async () => {
    await writeSignIn(ORIGIN, stored(10_000));
    let refreshes = 0;
    vi.stubGlobal("fetch", async () => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ access_token: `oauth:new-${refreshes}`, expires_in: 900, refresh_token: "r2" });
    });
    const tokens = await Promise.all([
      accessToken(ORIGIN),
      accessToken(ORIGIN),
      accessToken(ORIGIN),
    ]);
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(["oauth:new-1", "oauth:new-1", "oauth:new-1"]);
  });

  it("asks for a new sign-in, by the instance's address, when no refresh token is stored", async () => {
    await writeSignIn(ORIGIN, stored(-1, { refresh_token: undefined }));
    await expect(accessToken(ORIGIN)).rejects.toThrow(`Run \`npx kestrel login ${ORIGIN}\` again.`);
  });
});

describe("the credentials lock", () => {
  it("leaves the lock of whoever took it over, when its holder outlived the staleness rule", async () => {
    const lock = `${credentialsFile()}.lock`;
    await withCredentialsLock(async () => {
      // Another process judged this holder dead and took the lock over while it ran.
      rmSync(lock);
      writeFileSync(lock, "999:takeover");
    });
    expect(readFileSync(lock, "utf8")).toBe("999:takeover");
  });

  it("takes over a stale lock, and surfaces a timeout while the body is read", async () => {
    const lock = `${credentialsFile()}.lock`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, "1:dead");
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old);
    expect(await withCredentialsLock(async () => "got it")).toBe("got it");
    expect(() => statSync(lock)).toThrow();
    vi.stubGlobal("fetch", async (_url, init) => {
      const res = new Response("{}", { status: 200 });
      res.json = () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        });
      return res;
    });
    await expect(refreshTokens(stored(-1), 30)).rejects.toThrow(/didn't answer the token request/);
  });

  it("removes its own lock on release, and a later holder gets in", async () => {
    const lock = `${credentialsFile()}.lock`;
    await withCredentialsLock(async () => {
      expect(readFileSync(lock, "utf8")).toMatch(/^\d+:[0-9a-f]+$/);
    });
    expect(() => statSync(lock)).toThrow();
    expect(await withCredentialsLock(async () => "again")).toBe("again");
  });

  it("keeps both entries when a login for one instance races a refresh of another", async () => {
    const other = "https://b.example.com";
    await writeSignIn(ORIGIN, stored(10_000));
    let login;
    vi.stubGlobal("fetch", async () => {
      // The login arrives while the refresh holds the lock, so it has to wait its turn.
      login = writeSignIn(other, stored(60_000, { client_id: "client-b" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readSignIns()[other]).toBeUndefined();
      return json({ access_token: "oauth:new", expires_in: 900, refresh_token: "refresh-2" });
    });
    await accessToken(ORIGIN);
    await login;
    expect(readSignIn(ORIGIN)?.refresh_token).toBe("refresh-2");
    expect(readSignIn(other)?.client_id).toBe("client-b");
  });

  it("gives up on a token request that hangs, well before the lock would go stale", async () => {
    expect(TOKEN_TIMEOUT_MS).toBeLessThan(LOCK_WAIT_MS);
    expect(LOCK_WAIT_MS).toBeLessThan(LOCK_STALE_MS);
    vi.stubGlobal(
      "fetch",
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    );
    await expect(refreshTokens(stored(-1), 30)).rejects.toThrow(/didn't answer the token request/);
  });
});

describe("kestrel login's sign-in", () => {
  const AS = "https://team.cloudflareaccess.com";
  const realFetch = globalThis.fetch;

  const WHOAMI = () =>
    json({ principal: { kind: "human", email: "you@example.com", client: "claude-code" } });

  /** Access and the instance, stubbed by URL; the loopback callback stays real. */
  function stubAccess(whoami = WHOAMI) {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:")) {
        return realFetch(url, init);
      }
      calls.push({ url: u, init });
      if (u === `${ORIGIN}/api/whoami` && !init.headers?.authorization) {
        return json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer realm="OAuth", resource_metadata="${ORIGIN}/meta"`,
        });
      }
      if (u === `${ORIGIN}/meta`) {
        return json({ resource: `${ORIGIN}/api/whoami`, authorization_servers: [AS] });
      }
      if (u === `${AS}/.well-known/oauth-authorization-server`) {
        return json({
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
        });
      }
      if (u === `${AS}/register`) {
        return json({ client_id: "client-new" }, 201);
      }
      if (u === `${AS}/token`) {
        return json({ access_token: "oauth:a", expires_in: 900, refresh_token: "r" });
      }
      if (u === `${ORIGIN}/api/whoami`) {
        return whoami();
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    return calls;
  }

  /** Approve the sign-in as the browser would: follow the printed URL's redirect with a code. */
  function approveWhenAsked() {
    vi.spyOn(console, "log").mockImplementation((line) => {
      const m = /(https:\/\/team\S+authorize\S+)/.exec(String(line));
      if (m) {
        const asked = new URL(m[1]);
        const back = new URL(asked.searchParams.get("redirect_uri"));
        back.search = new URLSearchParams({
          code: "the-code",
          state: asked.searchParams.get("state"),
        }).toString();
        realFetch(back);
      }
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it("registers a public loopback client, then trades the code with its verifier, the redirect, and the resource", async () => {
    const calls = stubAccess();
    approveWhenAsked();
    const principal = await signIn(ORIGIN, { browser: false });
    expect(principal).toEqual({ kind: "human", email: "you@example.com", client: "claude-code" });

    const register = JSON.parse(String(calls.find((c) => c.url === `${AS}/register`)?.init.body));
    expect(register).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(register.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const form = new URLSearchParams(String(calls.find((c) => c.url === `${AS}/token`)?.init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("client-new");
    expect(form.get("redirect_uri")).toBe(register.redirect_uris[0]);
    expect(form.get("resource")).toBe(`${ORIGIN}/api/whoami`);
    expect(form.get("code_verifier")?.length).toBeGreaterThan(40);

    expect(readSignIn(ORIGIN)).toMatchObject({
      client_id: "client-new",
      redirect_uri: register.redirect_uris[0],
      access_token: "oauth:a",
      refresh_token: "r",
    });
  });

  it("reuses this computer's registered client while its redirect port is free", async () => {
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", async () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    await writeSignIn(
      ORIGIN,
      stored(-1, {
        registration_endpoint: `${AS}/register`,
        client_id: "client-kept",
        redirect_uri: `http://127.0.0.1:${port}/callback`,
      }),
    );
    const calls = stubAccess();
    approveWhenAsked();
    await signIn(ORIGIN, { browser: false });
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false);
    const form = new URLSearchParams(String(calls.find((c) => c.url === `${AS}/token`)?.init.body));
    expect(form.get("client_id")).toBe("client-kept");
  });

  // SPEC §11: an Access login that names no one is refused with a reason, and signing in
  // again the same way can't help, so the CLI says what to change instead.
  it("says the Access policy needs changing on access_unidentified, never to sign in again", async () => {
    stubAccess(() =>
      json({ error: "unauthorized", reason: "access_unidentified", message: "…" }, 401),
    );
    approveWhenAsked();
    const refused = await signIn(ORIGIN, { browser: false }).catch((e) => e);
    expect(refused.message).toMatch(
      /^Signed in to Access, but https:\/\/news\.example\.com\/api\/whoami answered 401 \(access_unidentified\)\. Access let you in but sent neither an email address nor a service token/,
    );
    expect(refused.message).toContain("Lock the dashboard with Access");
    expect(refused.message).not.toContain("kestrel login");
  });

  it("relays the instance's words on any other refusal", async () => {
    stubAccess(() => json({ error: "unauthorized", message: "Sign in: no credential." }, 401));
    approveWhenAsked();
    await expect(signIn(ORIGIN, { browser: false })).rejects.toThrow(
      `Signed in to Access, but ${ORIGIN}/api/whoami answered 401: Sign in: no credential.`,
    );
  });
});

describe("the loopback callback's wait", () => {
  it("gives up when no sign-in comes back in time", async () => {
    const listener = await listenForCode({ state: "s", timeoutMs: 20 });
    await expect(listener.code).rejects.toThrow(/No sign-in came back in time/);
  });
});
