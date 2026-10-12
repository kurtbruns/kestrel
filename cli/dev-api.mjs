/*
 * What the dev commands (seed, reset, and this repository's simulate-send) share: finding
 * this directory's dev server, minting a local admin token from it, and calling its API the
 * way any client does.
 *
 * They work only through the running server's HTTP API, never D1 or R2 directly, so what
 * they do is what the editor or Claude could do, and it lands in the database the server
 * is actually serving. The token comes from the dev-only `/api/dev/token` route, which
 * exists only on a local dev server (fake transport, no Access, a loopback origin).
 *
 * Seed and reset wipe the database of the server they reach, so a target they find for
 * themselves must prove it is this directory's: the port `kestrel dev` recorded here, and a
 * server there that reports the run ID recorded with it (cli/dev-server.mjs). A target the
 * caller names, a port or URL argument, is their choice and is used as given. `PORT` names
 * nothing here: a shell can carry it without the caller meaning anything by it, and a
 * target that wipes a database has to be named on purpose.
 */
import { readDevServer } from "./dev-server.mjs";

/** Split argv into `--flag value` / `--flag=value` pairs, bare `--flag`s (true), and
 *  positionals, so a script's flags can be given in any order. */
export function parseArgs(argv, booleans = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([^=]+)=(.*)$/.exec(a);
    if (eq) {
      flags[eq[1]] = eq[2];
    } else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleans.includes(name)) {
        flags[name] = true;
      } else {
        flags[name] = argv[i + 1] ?? "";
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Where a dev command aims, decided from what it was given and this directory's record:
 * `{ base, explicit: true }` for a port or URL argument, used as given;
 * `{ base, expectId }` for the recorded server, which must then report that ID
 * (`ownsServer`); or `{ refuse: "unrecorded" }` when nothing names a server and none is
 * recorded here. There is no fallback port: a guess could be another directory's server.
 */
export function chooseTarget({ arg, record }) {
  if (arg) {
    return { base: /^https?:\/\//.test(arg) ? arg : `http://localhost:${arg}`, explicit: true };
  }
  if (!record) {
    return { refuse: "unrecorded" };
  }
  return { base: `http://localhost:${record.port}`, expectId: record.id };
}

/** Whether the server at `target` may be acted on, given the run ID it reported (undefined
 *  when it reported none): always for a target the caller named, else only on a match. */
export function ownsServer(target, reportedId) {
  return target.explicit === true || (reportedId !== undefined && reportedId === target.expectId);
}

/**
 * The dev server to act on and a local admin token for it, `{ base, token }`, or exit saying
 * why there is none to act on (see `chooseTarget`). `arg` is the command's port or URL
 * argument, if any; `tag` names the command, as in `npm run <tag>`.
 */
export async function devTarget(arg, tag) {
  const target = chooseTarget({ arg, record: readDevServer() });
  const deliberately = [
    `To act on a server deliberately, name its port: \`npm run ${tag} -- <port>\`.`,
    ...(process.env.PORT
      ? [
          `(PORT=${process.env.PORT} is set, but PORT doesn't name a target here: a shell can carry it unawares.)`,
        ]
      : []),
  ];
  if (target.refuse) {
    fail(
      tag,
      "no dev server is recorded in this directory, so there is no server here to act on.",
      "Start one here with `npm run dev` (it runs `kestrel dev`, which records it), then run this again.",
      ...deliberately,
    );
  }
  const { token, runId } = await devToken(target.base, tag);
  if (!ownsServer(target, runId)) {
    fail(
      tag,
      `the server at ${target.base} isn't this directory's dev server, so it was left alone.`,
      runId === undefined
        ? "It reports no run ID, so it wasn't started by `npm run dev` here."
        : "It reports another run's ID: the server recorded here has stopped, and another holds its port.",
      "Start this directory's with `npm run dev`, then run this again.",
      ...deliberately,
    );
  }
  if (target.explicit) {
    console.log(`[${tag}] acting on ${target.base}, as named`);
  }
  return { base: target.base, token };
}

/** Print a failure under the script's tag and exit. */
export function fail(tag, ...lines) {
  const [first, ...rest] = lines;
  console.error(`[${tag}] ${first}`);
  for (const line of rest) {
    console.error(`${" ".repeat(tag.length + 3)}${line}`);
  }
  process.exit(1);
}

/** Mint a local admin token, a `service` principal as Claude is in production, with the run
 *  ID the server reports (undefined when it reports none), as `{ token, runId }`, or exit
 *  saying why the server can't give one. */
async function devToken(base, tag) {
  let res;
  try {
    res = await fetch(`${base}/api/dev/token?kind=service`);
  } catch (err) {
    fail(
      tag,
      `could not reach ${base}. Is the dev server running?`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (res.status === 404) {
    fail(
      tag,
      "/api/dev/token is unavailable: this only works on a local dev server (fake transport, no Access, APP_ORIGIN on localhost).",
    );
  }
  if (!res.ok) {
    // A refused deployment (a setting, or a database behind the release) says what to do.
    const { message } = await res.json().catch(() => ({}));
    fail(
      tag,
      `could not mint a dev token: ${res.status} ${res.statusText}`,
      ...(typeof message === "string" ? [message] : []),
    );
  }
  const { token, runId } = await res.json();
  return { token, runId: typeof runId === "string" && runId ? runId : undefined };
}

/** Call the API as `token`: JSON in, JSON out. Resolves `{ status, ok, body }`, or exits
 *  when the server can't be reached. */
export async function callApi(base, token, path, { method = "GET", json, tag = "dev" } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (json !== undefined) {
    headers["content-type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch (err) {
    fail(
      tag,
      `could not reach ${base}. Is the dev server running?`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}
