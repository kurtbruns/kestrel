/*
 * `kestrel api`: call an instance's API as the person signed in, naming the program the
 * request came through, the way Claude Code reaches Kestrel (SPEC §11, Who acted).
 *
 * Deployed, it sends the access token `kestrel login` stored, refreshing it from the
 * refresh token when it is about to expire or Access has turned it away, and storing what
 * comes back. Locally there is no Access: the target is this directory's dev server, and
 * the credential is the dev server's human token, so a local run is a person via Claude
 * Code just as a deployed one is. Every request carries `Kestrel-Client: claude-code`
 * unless `--client` names another program.
 *
 * It prints the answer's body as it came, so Claude reads a refusal's words and its next
 * move; a non-2xx answer also prints its status on stderr and exits 1, as curl --fail-with-body.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readSignIn, readSignIns, withCredentialsLock, writeSignInHeld } from "./credentials.mjs";
import { devTarget } from "./dev-api.mjs";
import {
  DEFAULT_CLIENT,
  instanceOrigin,
  isLoopback,
  needsRefresh,
  refreshTokens,
  SignInError,
  tokenFields,
} from "./oauth.mjs";

const USAGE = `Usage: kestrel api <method> <path> [options]

  --data <json|@file|->   the request body: inline, from a file, or from stdin
  --type <media type>     the body's type (default application/json)
  --form <name=value>     a multipart field, repeatable; name=@file attaches a file
  --url <url>             the instance (default: KESTREL_URL, else your one sign-in)
  --local                 this directory's dev server, started by kestrel dev
  --client <name>         the Kestrel-Client name to send (default ${DEFAULT_CLIENT})`;

/** Read `kestrel api`'s argv: method, path, and options, `--form` repeatable. */
export function parseApiArgs(argv) {
  const opts = { forms: [], local: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = /^--([^=]+)=(.*)$/s.exec(arg);
    const name = eq ? eq[1] : arg.startsWith("--") ? arg.slice(2) : undefined;
    if (name === undefined) {
      positional.push(arg);
      continue;
    }
    if (name === "local") {
      opts.local = true;
      continue;
    }
    if (!["data", "type", "form", "url", "client"].includes(name)) {
      throw new SignInError(`unknown option --${name}\n\n${USAGE}`);
    }
    const value = eq ? eq[2] : argv[++i];
    if (value === undefined) {
      throw new SignInError(`--${name} needs a value\n\n${USAGE}`);
    }
    if (name === "form") {
      opts.forms.push(value);
    } else {
      opts[name] = value;
    }
  }
  const [method, path, ...rest] = positional;
  if (!method || !path || rest.length) {
    throw new SignInError(USAGE);
  }
  if (!path.startsWith("/")) {
    throw new SignInError(`The path starts with a slash, as in /api/posts.\n\n${USAGE}`);
  }
  if (opts.data !== undefined && opts.forms.length) {
    throw new SignInError("Send --data or --form, not both.");
  }
  return { method: method.toUpperCase(), path, ...opts };
}

/**
 * Which instance a call goes to: `--url`, then `KESTREL_URL`, then the one instance this
 * person is signed in to. Several sign-ins and nothing naming one is a refusal, not a guess.
 */
export function chooseInstance({ url, env = process.env, signIns }) {
  if (url) {
    return instanceOrigin(url);
  }
  if (env.KESTREL_URL) {
    return instanceOrigin(env.KESTREL_URL);
  }
  const origins = Object.keys(signIns);
  if (origins.length === 1) {
    return origins[0];
  }
  if (origins.length === 0) {
    throw new SignInError(
      "You aren't signed in to an instance. Run `npx kestrel login <url>` first, or --local for this directory's dev server.",
    );
  }
  throw new SignInError(
    `You're signed in to ${origins.length} instances (${origins.join(", ")}). Name one with --url or KESTREL_URL.`,
  );
}

/** The request body and its headers, from --data, --type, and --form. */
async function requestBody({ data, type, forms }) {
  if (forms.length) {
    const form = new FormData();
    for (const field of forms) {
      const at = field.indexOf("=");
      if (at < 1) {
        throw new SignInError(`--form takes name=value or name=@file, not "${field}".`);
      }
      const name = field.slice(0, at);
      const value = field.slice(at + 1);
      if (value.startsWith("@")) {
        const file = value.slice(1);
        form.append(name, new Blob([readFileSync(file)]), basename(file));
      } else {
        form.append(name, value);
      }
    }
    return { body: form, headers: {} };
  }
  if (data === undefined) {
    return { body: undefined, headers: {} };
  }
  let body;
  if (data === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } else if (data.startsWith("@")) {
    body = readFileSync(data.slice(1));
  } else {
    body = data;
  }
  return { body, headers: { "content-type": type ?? "application/json" } };
}

/**
 * A usable access token for `origin`'s stored sign-in, refreshed first when it is about to
 * expire, or when `force` says Access just turned it away. The refresh runs under the
 * credentials lock, and a call that waited there uses the token the other stored, so one
 * refresh token is never spent twice. A grant that has ended leaves the person to sign in
 * again.
 */
export async function accessToken(origin, { force = false, env = process.env } = {}) {
  const ended = `Your sign-in to ${origin} has ended. Run \`npx kestrel login ${origin}\` again.`;
  const entry = readSignIn(origin, env);
  if (!entry) {
    throw new SignInError(
      `You aren't signed in to ${origin}. Run \`npx kestrel login ${origin}\`.`,
    );
  }
  if (!force && !needsRefresh(entry)) {
    return entry.access_token;
  }
  // The token Access just refused, when it did: a stored token equal to it is no use.
  const refused = force ? entry.access_token : undefined;
  return withCredentialsLock(async () => {
    const now = readSignIn(origin, env);
    if (!now) {
      throw new SignInError(
        `You aren't signed in to ${origin}. Run \`npx kestrel login ${origin}\`.`,
      );
    }
    if (!needsRefresh(now) && now.access_token !== refused) {
      return now.access_token;
    }
    if (!now.refresh_token) {
      throw new SignInError(ended);
    }
    try {
      const fields = tokenFields(await refreshTokens(now), now);
      writeSignInHeld(origin, { ...now, ...fields }, env);
      return fields.access_token;
    } catch (err) {
      if (err instanceof SignInError && err.oauthError === "invalid_grant") {
        throw new SignInError(ended);
      }
      throw err;
    }
  }, env);
}

/**
 * Call `origin`'s API as the signed-in person: one retry after a refresh when Access answers
 * 401, since a token can be revoked or shortened before its stated expiry. Answers the
 * Response.
 */
export async function signedInFetch(origin, path, { method = "GET", body, headers = {}, client }) {
  const send = async (token) =>
    fetch(`${origin}${path}`, {
      method,
      body,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...headers,
        "kestrel-client": client,
        authorization: `Bearer ${token}`,
      },
    });
  let res = await send(await accessToken(origin));
  // Access's own refusal names its OAuth metadata; the app's 401 doesn't, and a fresh token
  // wouldn't change it. A streamed body (stdin) can't be sent twice, but it is read whole.
  if (res.status === 401 && /resource_metadata=/.test(res.headers.get("www-authenticate") ?? "")) {
    res = await send(await accessToken(origin, { force: true }));
  }
  return res;
}

/** `kestrel api <method> <path> [options]`. */
export async function apiCommand(argv) {
  let res;
  try {
    const args = parseApiArgs(argv);
    const client = args.client ?? DEFAULT_CLIENT;
    const { body, headers } = await requestBody(args);
    // A loopback address, given or in KESTREL_URL, is a dev server, which has no sign-in.
    const named = args.url || process.env.KESTREL_URL || undefined;
    if (args.local || (named && isLoopback(instanceOrigin(named)))) {
      // A local dev server: its own human token, minted as the editor's is (SPEC §10).
      const { base, token } = await devTarget(
        args.local ? undefined : instanceOrigin(named),
        "api",
        "human",
      );
      res = await fetch(`${base}${args.path}`, {
        method: args.method,
        body,
        headers: {
          accept: "application/json",
          ...headers,
          "kestrel-client": client,
          authorization: `Bearer ${token}`,
        },
      });
    } else {
      const origin = chooseInstance({ url: args.url, signIns: readSignIns() });
      res = await signedInFetch(origin, args.path, {
        method: args.method,
        body,
        headers,
        client,
      });
    }
  } catch (err) {
    console.error(`kestrel api: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const text = await res.text();
  if (text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (!res.ok) {
    console.error(`kestrel api: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    process.exit(1);
  }
}
