/*
 * `kestrel login` and `kestrel logout`: sign this computer in to a deployed instance as the
 * person at it, through Cloudflare Access's Managed OAuth, and forget that sign-in again.
 *
 * The person approves the sign-in in their browser, through the same Access policy the
 * editor's sign-in passes, so Claude Code working through `kestrel api` afterwards is that
 * person, not a token of its own (SPEC §11). The OAuth steps are cli/oauth.mjs, and where
 * the result is kept is cli/credentials.mjs.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { signedInFetch } from "./api.mjs";
import { credentialsFile, readSignIn, readSignIns, writeSignIn } from "./credentials.mjs";
import {
  authorizeUrl,
  DEFAULT_CLIENT,
  discover,
  exchangeCode,
  instanceOrigin,
  isLoopback,
  listenForCode,
  PROTECTED_PATH,
  pkcePair,
  registerClient,
  revokeTokens,
  SignInError,
  tokenFields,
} from "./oauth.mjs";
import { unauthorizedMove } from "./openapi.mjs";

/** Open `url` in the person's browser, best effort: the URL is printed either way. */
function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser to open: the printed URL still works */
  }
}

/** Sign in to `origin`, store the result, and answer who it signed in as. */
export async function signIn(origin, { browser }) {
  const found = await discover(origin);
  const stored = readSignIn(origin);
  // A client registered for this computer is reused while its redirect can be served again,
  // so a sign-in doesn't leave a new registration in Access each time.
  const reuse =
    stored?.client_id && stored.registration_endpoint === found.registration_endpoint
      ? stored
      : undefined;
  const state = randomBytes(16).toString("base64url");
  const listener = await listenForCode({
    port: reuse ? Number(new URL(reuse.redirect_uri).port) : undefined,
    state,
  });
  try {
    const clientId =
      reuse && reuse.redirect_uri === listener.redirectUri
        ? reuse.client_id
        : await registerClient(found.registration_endpoint, listener.redirectUri);
    const entry = { ...found, client_id: clientId, redirect_uri: listener.redirectUri };
    const { verifier, challenge } = pkcePair();
    const url = authorizeUrl({
      endpoint: found.authorization_endpoint,
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
      resource: found.resource,
    });
    console.log(`Approve the sign-in to ${origin} in your browser.`);
    console.log(`If it didn't open, go to:\n\n  ${url}\n`);
    if (browser) {
      openBrowser(url);
    }
    const code = await listener.code;
    const fields = tokenFields(await exchangeCode(entry, { code, verifier }));
    await writeSignIn(origin, { ...entry, ...fields });
  } finally {
    listener.close();
  }
  const res = await signedInFetch(origin, PROTECTED_PATH, { client: DEFAULT_CLIENT });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const move = unauthorizedMove(body);
    throw new SignInError(
      move
        ? `Signed in to Access, but ${origin}${PROTECTED_PATH} answered ${res.status} (${body.reason}). ${move}.`
        : `Signed in to Access, but ${origin}${PROTECTED_PATH} answered ${res.status}${body?.message ? `: ${body.message}` : ""}.`,
    );
  }
  return body?.principal;
}

/** `kestrel login <url> [--no-browser]`. */
export async function loginCommand(argv) {
  const browser = !argv.includes("--no-browser");
  const urls = argv.filter((a) => a !== "--no-browser");
  try {
    if (urls.length !== 1) {
      throw new SignInError("Usage: kestrel login <url> [--no-browser]");
    }
    const origin = instanceOrigin(urls[0]);
    if (isLoopback(origin)) {
      throw new SignInError(
        "A local dev server needs no sign-in: `npx kestrel api --local …` calls it as you.",
      );
    }
    const principal = await signIn(origin, { browser });
    const who = principal?.email ?? principal?.kind ?? "someone";
    console.log(`Signed in to ${origin} as ${who}.`);
    console.log(
      `Stored in ${credentialsFile()}. \`npx kestrel api GET /api/posts\` calls it as you.`,
    );
  } catch (err) {
    console.error(`kestrel login: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** `kestrel logout [url]`: revoke and forget one sign-in, or the only one stored. */
export async function logoutCommand(argv) {
  try {
    const origins = Object.keys(readSignIns());
    const origin = argv[0] ? instanceOrigin(argv[0]) : origins.length === 1 ? origins[0] : null;
    if (!origin) {
      throw new SignInError(
        origins.length
          ? `You're signed in to ${origins.join(", ")}. Name the one to sign out of.`
          : "You aren't signed in to any instance.",
      );
    }
    const entry = readSignIn(origin);
    if (!entry) {
      throw new SignInError(`You aren't signed in to ${origin}.`);
    }
    const revoked = await revokeTokens(entry);
    await writeSignIn(origin, undefined);
    console.log(
      revoked
        ? `Signed out of ${origin}, and Access revoked the sign-in.`
        : `Signed out of ${origin} on this computer. Access didn't confirm revoking it; it ends with the Access application's grant session.`,
    );
  } catch (err) {
    console.error(`kestrel logout: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
