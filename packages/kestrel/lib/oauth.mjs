/*
 * The OAuth client `kestrel login` and `kestrel api` share, for an instance behind
 * Cloudflare Access with Managed OAuth on (SPEC §11). Access is the authorization server:
 * the app never sees this token, only the signed assertion Access forwards in its place, so
 * a person signed in here is the same principal as in the editor.
 *
 * Everything is discovered from the instance itself. A request to a protected path with no
 * credential is answered 401 by Access, whose `WWW-Authenticate` names the protected
 * resource's metadata (RFC 9728), which names the authorization server, whose own metadata
 * (RFC 8414) names its endpoints. The path asked is `/api/whoami`, because `/` is public and
 * Access has nothing to say about it. Then: dynamic client registration (RFC 7591) for a
 * public client on a loopback redirect (RFC 8252), the authorization code flow with PKCE
 * (S256), and the protected resource named in every token request (RFC 8707). Plain Node,
 * no dependency, as the whole client is.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** The path discovery and the sign-in's check ask: protected, and it answers who signed in. */
export const PROTECTED_PATH = "/api/whoami";

/** The name `kestrel api` gives its requests, unless told another (SPEC §11, Who acted). */
export const DEFAULT_CLIENT = "claude-code";

// How long before its expiry an access token is refreshed rather than sent.
const REFRESH_MARGIN_MS = 60_000;

/** Thrown with words for the person: what went wrong and what to do. */
export class SignInError extends Error {}

/** Whether an origin is this computer (a local dev server), where Access never stands. */
export function isLoopback(origin) {
  const { hostname } = new URL(origin);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * The origin an instance URL names, which a sign-in is stored under. A path, query, or
 * trailing slash is dropped, so `https://news.example.com/dashboard/` and the bare host are
 * one instance. A host given without a scheme means https; plain http is refused for
 * anything but this computer, since a token would cross the network in the clear.
 */
export function instanceOrigin(url) {
  const text = String(url ?? "").trim();
  if (!text) {
    throw new SignInError("Name the instance, such as https://news.example.com.");
  }
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new SignInError(`"${text}" isn't a URL.`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.origin))) {
    throw new SignInError(`${parsed.origin} isn't https, and a sign-in only travels over https.`);
  }
  return parsed.origin;
}

/** The `resource_metadata` a `WWW-Authenticate` header names (RFC 9728), or undefined. */
export function resourceMetadataUrl(header) {
  const match = /resource_metadata="([^"]+)"/.exec(header ?? "");
  return match ? match[1] : undefined;
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Whether a stored sign-in's access token should be refreshed before it is sent. */
export function needsRefresh(entry, now = Date.now()) {
  return !entry.access_token || !(entry.expires_at > now + REFRESH_MARGIN_MS);
}

/**
 * The stored fields a token response sets: the access token, when it expires, and the
 * refresh token, kept from before when the server didn't send a new one.
 */
export function tokenFields(body, previous = {}, now = Date.now()) {
  if (!body || typeof body.access_token !== "string") {
    throw new SignInError("Access answered without an access token.");
  }
  const lifetime = Number(body.expires_in);
  return {
    access_token: body.access_token,
    // No expires_in means none was promised: refresh after a minute rather than trust it long.
    expires_at: now + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 60) * 1000,
    refresh_token:
      typeof body.refresh_token === "string" ? body.refresh_token : previous.refresh_token,
  };
}

async function getJson(url, what) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new SignInError(`Couldn't reach ${new URL(url).origin} for ${what}: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new SignInError(`${what} answered ${res.status} at ${url}.`);
  }
  return res.json();
}

/**
 * What a sign-in to `origin` needs to know, found from the instance as described above:
 * `{ resource, issuer, authorization_endpoint, token_endpoint, registration_endpoint,
 * revocation_endpoint }`. Throws a SignInError that says what to turn on when the instance
 * offers no OAuth sign-in.
 */
export async function discover(origin) {
  let res;
  try {
    res = await fetch(`${origin}${PROTECTED_PATH}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  } catch (err) {
    throw new SignInError(`Couldn't reach ${origin}: ${errText(err)}`);
  }
  const metadataUrl = resourceMetadataUrl(res.headers.get("www-authenticate"));
  if (res.status !== 401 || !metadataUrl) {
    throw new SignInError(
      `${origin} doesn't offer a sign-in for programs (it answered ${res.status} with no OAuth metadata).`,
    );
  }
  const resource = await getJson(metadataUrl, "the protected resource's metadata");
  const issuer = resource.authorization_servers?.[0];
  if (typeof resource.resource !== "string" || typeof issuer !== "string") {
    throw new SignInError(`The metadata at ${metadataUrl} names no authorization server.`);
  }
  const server = await getJson(
    `${issuer}/.well-known/oauth-authorization-server`,
    "the authorization server's metadata",
  );
  if (!server.authorization_endpoint || !server.token_endpoint) {
    throw new SignInError(`${issuer} publishes no authorization or token endpoint.`);
  }
  if (!server.registration_endpoint) {
    throw new SignInError(
      `${issuer} offers no client registration. Turn on Managed OAuth for the instance's Access application, as the guide Allow Claude to connect says.`,
    );
  }
  return {
    resource: resource.resource,
    issuer,
    authorization_endpoint: server.authorization_endpoint,
    token_endpoint: server.token_endpoint,
    registration_endpoint: server.registration_endpoint,
    revocation_endpoint: server.revocation_endpoint,
  };
}

/** Register a public client for this computer's loopback redirect; answers its client_id. */
export async function registerClient(registrationEndpoint, redirectUri) {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Kestrel CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.client_id !== "string") {
    throw new SignInError(
      `Access refused to register this computer's sign-in (${res.status}${body.error_description ? `: ${body.error_description}` : body.error ? `: ${body.error}` : ""}). In the Access application's Managed OAuth settings, turn on Allow loopback clients.`,
    );
  }
  return body.client_id;
}

/** The URL the browser opens to sign in. */
export function authorizeUrl({ endpoint, clientId, redirectUri, challenge, state, resource }) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
  }).toString();
  return url.toString();
}

/** How long a token request may take. Under the credentials lock's staleness rule (30 s) and a waiter's patience (25 s), so a refresh that holds the lock never outlasts either. */
export const TOKEN_TIMEOUT_MS = 10_000;

/** POST a form to the token endpoint, answering its JSON, or throwing with its words. */
async function tokenRequest(endpoint, form, timeoutMs = TOKEN_TIMEOUT_MS) {
  let res;
  let body;
  try {
    res = await fetch(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    // The timeout covers reading the body too; only an unreadable body is let go.
    body = await res.json().catch((err) => {
      if (err?.name === "TimeoutError") {
        throw err;
      }
      return {};
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new SignInError(
        `${new URL(endpoint).origin} didn't answer the token request within ${timeoutMs / 1000} seconds. Try again.`,
      );
    }
    throw new SignInError(`Couldn't reach ${new URL(endpoint).origin}: ${errText(err)}`);
  }
  if (!res.ok) {
    const error = new SignInError(
      `Access refused the token request (${res.status}${body.error ? `: ${body.error}` : ""}${body.error_description ? `, ${body.error_description}` : ""}).`,
    );
    error.oauthError = body.error;
    throw error;
  }
  return body;
}

/** Trade the browser's authorization code for tokens. */
export function exchangeCode(entry, { code, verifier }, timeoutMs) {
  return tokenRequest(
    entry.token_endpoint,
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: entry.client_id,
      redirect_uri: entry.redirect_uri,
      resource: entry.resource,
    },
    timeoutMs,
  );
}

/** A new access token from the stored refresh token. Access checks its policies again. */
export function refreshTokens(entry, timeoutMs) {
  if (!entry.refresh_token) {
    throw new SignInError("This sign-in can't be renewed. Run `npx kestrel login <url>` again.");
  }
  return tokenRequest(
    entry.token_endpoint,
    {
      grant_type: "refresh_token",
      refresh_token: entry.refresh_token,
      client_id: entry.client_id,
      resource: entry.resource,
    },
    timeoutMs,
  );
}

/** Revoke the stored refresh token, best effort: forgetting it locally is what logout owes. */
export async function revokeTokens(entry) {
  if (!entry.revocation_endpoint || !entry.refresh_token) {
    return false;
  }
  try {
    const res = await fetch(entry.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: entry.refresh_token,
        token_type_hint: "refresh_token",
        client_id: entry.client_id,
      }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const DONE_PAGE = (heading, line) =>
  `<!doctype html><meta charset="utf-8"><title>Kestrel</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${heading}</h1><p>${line}</p></body>`;

/**
 * Listen on this computer's loopback for the browser's return from the sign-in. Tries
 * `port` first, so a stored client's redirect still matches, and any free port when that
 * one is taken. Answers `{ redirectUri, code }`, where `code` resolves to the authorization
 * code once a request carrying `state` arrives, and rejects on Access's refusal or after
 * `timeoutMs`.
 */
export async function listenForCode({ port, state, timeoutMs = 5 * 60_000 }) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    // A request that doesn't carry this sign-in's state isn't its answer, whatever it says.
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE("That sign-in link is stale", "Run kestrel login again."));
      return;
    }
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    res.writeHead(error || !got ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
    if (error || !got) {
      res.end(DONE_PAGE("Sign-in refused", "Go back to the terminal to see why."));
      const description = url.searchParams.get("error_description");
      settle.reject(
        new SignInError(
          `The sign-in was refused (${error ?? "no code"}${description ? `: ${description}` : ""}).`,
        ),
      );
    } else {
      res.end(DONE_PAGE("Signed in to Kestrel", "You can close this tab."));
      settle.resolve(got);
    }
  });
  const bound = await new Promise((resolve, reject) => {
    const tryPort = (p, fallback) => {
      server.once("error", (err) => {
        if (fallback && err.code === "EADDRINUSE") {
          tryPort(0, false);
        } else {
          reject(err);
        }
      });
      server.listen(p, "127.0.0.1", () => resolve(server.address().port));
    };
    tryPort(port ?? 0, Boolean(port));
  });
  const timer = setTimeout(
    () =>
      settle.reject(
        new SignInError("No sign-in came back in time. Run `npx kestrel login <url>` again."),
      ),
    timeoutMs,
  );
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${bound}/callback`, code, close };
}

function errText(err) {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err instanceof Error ? err.message : String(err)}${cause}`;
}
