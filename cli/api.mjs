/*
 * `kestrel api`: call an instance's API as the person signed in, naming the program the
 * request came through, the way Claude Code reaches Kestrel (SPEC §11, Who acted).
 *
 * Deployed, it sends the access token `kestrel login` stored, refreshing it from the
 * refresh token when it is about to expire or Access has turned it away, and storing what
 * comes back. Locally there is no Access: the target is this directory's dev server, and
 * the credential is the dev server's human token, so a local run is a person via Claude
 * Code just as a deployed one is. Every request carries `Kestrel-Client: claude-code`
 * unless `--client` names another program, so a person's own script can name itself. It
 * never names the editor: the server trusts the name it is sent (SPEC, Trusted, not guarded),
 * and the editor's name lifts a step only a person in the editor may take (SPEC §7).
 *
 * It prints the answer's body as it came, so a script or Claude reads a refusal whole; a
 * non-2xx answer also prints its status, and a refusal's code, message, field, and next move,
 * on stderr and exits 1, as curl --fail-with-body.
 *
 * What the API is comes from the instance itself: `--list` and `help` read its OpenAPI
 * document through the same sign-in, as `-f` and `-F` do to build a body and refuse a field
 * the route doesn't take (cli/openapi.mjs). It is read fresh each time it is needed, not
 * cached, so it can never describe a release the instance no longer runs.
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
import {
  buildFields,
  describeRefusal,
  describeRoute,
  findOperation,
  listRoutes,
} from "./openapi.mjs";

const USAGE = `Usage: kestrel api <method> <path> [options]
       kestrel api --list [resource]       the instance's routes, or one resource's
       kestrel api help <method> <path>    one route: its fields, refusals, and answer

  -f, --raw-field <name=value>  a body field, as a string; repeatable. On a GET, or for a name
                                the route takes only as one, a query parameter
  -F, --field <name=value>      a body field typed by the route's schema (true, 3, null, JSON),
                                or name=@file for a file's text. name.sub nests; name[] lists
  --data <json|@file|->         the request body: inline, from a file, or from stdin
  --type <media type>           the body's type (default application/json)
  --form <name=value>           a multipart field, repeatable; name=@file attaches a file
  --url <url>                   the instance (default: KESTREL_URL, else your one sign-in)
  --local                       this directory's dev server, started by kestrel dev
  --client <name>               your own script's Kestrel-Client name (default ${DEFAULT_CLIENT});
                                never editor, which only the editor names itself

The routes, fields, and refusals come from the instance's own /api/openapi.json, so they
match the release it runs. A field the route doesn't take is refused before the request.`;

// The name only the editor sends; `kestrel api` refuses to claim it (SPEC §7, §11).
const EDITOR_CLIENT = "editor";

// The server's rule for a client name (shared/who_acted.ts), mirrored since the CLI is plain
// Node; a spec holds the two equal. Checking it here, after the trim fetch applies to a header
// value, means the name refused is the one the server would have read.
export const CLIENT_NAME_MAX = 32;
export const CLIENT_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const ONE_WAY = "Send the body one way: --data, --form, or -f and -F fields, not two.";

// Options that take a value, by the name they are stored under.
const VALUED = {
  data: "data",
  type: "type",
  url: "url",
  client: "client",
  form: "forms",
  "raw-field": "fields",
  f: "fields",
  field: "fields",
  F: "fields",
};

/**
 * Read `kestrel api`'s argv. A call is a method and a path, `--form`, `-f`, and `-F`
 * repeatable; `--list [resource]`, `help`, and `help <resource>` list the routes, and
 * `help <method> <path>` describes one. The body is sent one way: `--data`, `--form`, or
 * fields, never two at once, since merging them would leave a reader guessing which won; a
 * field that is a query parameter may go beside `--data` or `--form`.
 */
export function parseApiArgs(argv) {
  const opts = { forms: [], fields: [], local: false, list: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = /^--([^=]+)=(.*)$/s.exec(arg);
    const short = /^-([A-Za-z])$/.exec(arg);
    const name = eq ? eq[1] : short ? short[1] : arg.startsWith("--") ? arg.slice(2) : undefined;
    if (name === undefined) {
      positional.push(arg);
      continue;
    }
    if (name === "local" || name === "list") {
      // `--list=sends` names its resource as `--list sends` does; --local names nothing.
      if (eq && name === "local") {
        throw new SignInError(`--local takes no value; to name a server, use --url <url>.`);
      }
      if (eq) {
        positional.push(eq[2]);
      }
      opts[name] = true;
      continue;
    }
    const key = VALUED[name];
    const flag = short ? `-${name}` : `--${name}`;
    if (!key) {
      throw new SignInError(`unknown option ${flag}\n\n${USAGE}`);
    }
    const value = eq ? eq[2] : argv[++i];
    if (value === undefined) {
      throw new SignInError(`${flag} needs a value\n\n${USAGE}`);
    }
    if (key === "fields") {
      opts.fields.push({ typed: name === "F" || name === "field", text: value });
    } else if (key === "forms") {
      opts.forms.push(value);
    } else {
      opts[key] = value;
    }
  }
  if (opts.client !== undefined) {
    opts.client = opts.client.trim();
    if (
      opts.client.length > CLIENT_NAME_MAX ||
      !new RegExp(CLIENT_NAME_PATTERN).test(opts.client)
    ) {
      throw new SignInError(
        `--client takes one short lowercase word, its parts joined by hyphens (my-script), up to ${CLIENT_NAME_MAX} characters.`,
      );
    }
    if (opts.client === EDITOR_CLIENT) {
      throw new SignInError(
        "--client editor is refused: only the editor names itself the editor, since some acts only a person in the editor may confirm. Name your own program, or leave --client out.",
      );
    }
  }
  const { list, ...rest } = opts;
  const bodies = [opts.data !== undefined, opts.forms.length > 0, opts.fields.length > 0];
  const help = positional[0] === "help";
  if (list || help) {
    const args = help ? positional.slice(1) : positional;
    if (bodies.some(Boolean)) {
      throw new SignInError("--list and help send nothing, so they take no body or fields.");
    }
    if (args.length === 2 && help) {
      const [method, path] = args;
      return { mode: "help", method: method.toUpperCase(), path, ...rest };
    }
    if (args.length > 1) {
      throw new SignInError(USAGE);
    }
    return { mode: "list", resource: args[0], ...rest };
  }
  const [method, path, ...extra] = positional;
  if (!method || !path || extra.length) {
    throw new SignInError(USAGE);
  }
  if (!path.startsWith("/")) {
    throw new SignInError(`The path starts with a slash, as in /api/posts.\n\n${USAGE}`);
  }
  // Fields may go with --data or --form only as query parameters, which apiCommand checks
  // once it knows where each field goes.
  if (bodies[0] && bodies[1]) {
    throw new SignInError(ONE_WAY);
  }
  return { mode: "call", method: method.toUpperCase(), path, ...rest };
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

/**
 * How a run reaches its instance: a function that sends one request there and answers the
 * Response. A loopback address, given or in KESTREL_URL, is a dev server, which has no sign-in:
 * its own human token is minted as the editor's is (SPEC §10). Anything else is the stored
 * sign-in, refreshed as it needs.
 */
async function openTarget(args, client) {
  const named = args.url || process.env.KESTREL_URL || undefined;
  if (args.local || (named && isLoopback(instanceOrigin(named)))) {
    const { base, token } = await devTarget(
      args.local ? undefined : instanceOrigin(named),
      "api",
      "human",
    );
    return (path, { method = "GET", body, headers = {} } = {}) =>
      fetch(`${base}${path}`, {
        method,
        body,
        headers: {
          accept: "application/json",
          ...headers,
          "kestrel-client": client,
          authorization: `Bearer ${token}`,
        },
      });
  }
  const origin = chooseInstance({ url: args.url, signIns: readSignIns() });
  return (path, { method = "GET", body, headers = {} } = {}) =>
    signedInFetch(origin, path, { method, body, headers, client });
}

/** The instance's OpenAPI document, read through `call`, or a refusal saying why there is none. */
export async function readOpenApi(call) {
  const res = await call("/api/openapi.json");
  const text = await res.text();
  if (res.status === 404) {
    throw new SignInError(
      "This instance serves no /api/openapi.json, so its routes can't be listed or checked: it runs a release older than this CLI's. Send a body with --data instead.",
    );
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  if (!res.ok || !doc?.paths) {
    const said = typeof doc?.message === "string" ? `: ${doc.message}` : "";
    throw new SignInError(
      `Couldn't read the instance's /api/openapi.json (HTTP ${res.status})${said}`,
    );
  }
  return doc;
}

/** A call's path with `query`'s pairs appended to whatever query string it already has. */
function withQuery(path, query) {
  if (!query.length) {
    return path;
  }
  const params = new URLSearchParams(query);
  return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/**
 * `kestrel api`: list the routes, describe one, or call one. A call prints the answer's body
 * on stdout as it came; on a non-2xx answer it also prints the status and, for a refusal, its
 * code, message, field, and next move on stderr, and exits 1.
 */
export async function apiCommand(argv) {
  let res;
  let doc;
  let found;
  let call;
  try {
    const args = parseApiArgs(argv);
    const client = args.client ?? DEFAULT_CLIENT;
    call = await openTarget(args, client);
    if (args.mode === "list") {
      console.log(listRoutes(await readOpenApi(call), args.resource));
      return;
    }
    if (args.mode === "help") {
      console.log(describeRoute(await readOpenApi(call), args.method, args.path));
      return;
    }
    let path = args.path;
    let { body, headers } = await requestBody(args);
    if (args.fields.length) {
      doc = await readOpenApi(call);
      found = findOperation(doc, args.method, path);
      if (!found) {
        throw new SignInError(
          `This instance has no route ${args.method} ${path.split("?")[0]}, so its fields can't be checked. \`kestrel api --list\` lists them.`,
        );
      }
      const built = buildFields(doc, found, args.fields);
      path = withQuery(path, built.query);
      if (built.body && body !== undefined) {
        throw new SignInError(ONE_WAY);
      }
      if (built.body) {
        body = JSON.stringify(built.body);
        headers = { "content-type": "application/json" };
      }
    }
    res = await call(path, { method: args.method, body, headers });
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
    for (const line of (await refusalLines(text, { doc, found, call })) ?? []) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }
}

/**
 * A refusal's readable lines, its next move from the instance's document (read now if the
 * call didn't already), or undefined when the body isn't a refusal. A document that can't be
 * read only leaves the move out: the refusal itself is already printed.
 */
async function refusalLines(text, { doc, found, call }) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body?.error !== "string") {
    return undefined;
  }
  let known = doc;
  if (!known) {
    known = await readOpenApi(call).catch(() => undefined);
  }
  return describeRefusal(body, { doc: known, op: found?.op });
}
