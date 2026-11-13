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
 * It lives in the client package, beside `kestrel api`, because `kestrel api --local` finds and
 * signs in to the dev server the same way; the instance package's seed and reset import it
 * from the copy of the client it ships, so the two never disagree about the record.
 *
 * Seed and reset wipe the database of the server they reach, so a target they find for
 * themselves must prove it is this directory's: the port `kestrel dev` recorded here, and a
 * server there that reports the run ID recorded with it (packages/kestrel/lib/dev-server.mjs). A target the
 * caller names, a port or URL argument, is their choice and is used as given. `PORT` names
 * nothing here: a shell can carry it without the caller meaning anything by it, and a
 * target that wipes a database has to be named on purpose.
 */
import { readDevServer } from "./dev-server.mjs";
import { CliError } from "./errors.mjs";
import { discardBody } from "./oauth.mjs";

/**
 * Where a dev command aims, decided from what it was given and this directory's record:
 * `{ base, explicit: true }` for a port or URL argument, used as given;
 * `{ base, expectId }` for the recorded server, which must then report that ID
 * (`ownsServer`); or `{ refuse: "unrecorded" }` when nothing names a server and none is
 * recorded here. There is no fallback port: a guess could be another directory's server.
 */
export function planDevTarget({ arg, record }) {
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
 * The dev server to act on and a local admin token for it, `{ base, token }`, or a CliError
 * saying why there is none to act on (see `planDevTarget`). `arg` is the command's port or URL
 * argument, if any; `tag` names the command, as in `npm run <tag>`. `kind` is the token's
 * principal: `service` for a script, as seed and reset are, and `human` for a person working
 * through a client, as `kestrel api` is (SPEC §11, Who acted).
 */
export async function connectDevServer(arg, tag, kind = "service") {
  const target = planDevTarget({ arg, record: readDevServer() });
  const naming =
    tag === "api"
      ? "`npx kestrel api --url http://localhost:<port> …`"
      : `\`npm run ${tag} -- <port>\``;
  const deliberately = [
    `To act on a server deliberately, name its port: ${naming}.`,
    ...(process.env.PORT
      ? [
          `(PORT=${process.env.PORT} is set, but PORT doesn't name a target here: a shell can carry it unawares.)`,
        ]
      : []),
  ];
  if (target.refuse) {
    fail(
      "no dev server is recorded in this directory, so there is no server here to act on.",
      "Start one here with `npm run dev` (it runs `kestrel dev`, which records it), then run this again.",
      ...deliberately,
    );
  }
  const { token, runId } = await devToken(target.base, kind);
  if (!ownsServer(target, runId)) {
    fail(
      `the server at ${target.base} isn't this directory's dev server, so it was left alone.`,
      runId === undefined
        ? "It reports no run ID, so it wasn't started by `npm run dev` here."
        : "It reports another run's ID: the server recorded here has stopped, and another holds its port.",
      "Start this directory's with `npm run dev`, then run this again.",
      ...deliberately,
    );
  }
  if (target.explicit) {
    console.error(`[${tag}] acting on ${target.base}, as named`);
  }
  return { base: target.base, token };
}

/** Stop the command with `first`, and `rest` indented under it (packages/kestrel/lib/errors.mjs). */
export function fail(first, ...rest) {
  throw new CliError(first, { lines: rest });
}

/** Mint a local admin token for a principal of `kind`, with the run ID the server reports
 *  (undefined when it reports none), as `{ token, runId }`, or throws a CliError saying why the
 *  server can't give one. */
async function devToken(base, kind) {
  let res;
  try {
    res = await fetch(`${base}/api/dev/token?kind=${kind}`);
  } catch (err) {
    fail(
      `could not reach ${base}. Is the dev server running?`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (res.status === 404) {
    await discardBody(res);
    fail(
      "/api/dev/token is unavailable: this only works on a local dev server (fake transport, no Access, APP_ORIGIN on localhost).",
    );
  }
  if (!res.ok) {
    // A refused deployment (a setting, or a database behind the release) says what to do.
    const { message } = await res.json().catch(() => ({}));
    fail(
      `could not mint a dev token: ${res.status} ${res.statusText}`,
      ...(typeof message === "string" ? [message] : []),
    );
  }
  // Another program on that port (another app's dev server) can answer 200 with a page.
  const answer = await res.json().catch(() => undefined);
  if (typeof answer?.token !== "string") {
    fail(`the server at ${base} didn't answer as a Kestrel dev server.`);
  }
  const { token, run_id: runId } = answer;
  return { token, runId: typeof runId === "string" && runId ? runId : undefined };
}

/** Call the API as `token`: JSON in, JSON out. Resolves `{ status, ok, body }`, or throws a
 *  CliError when the server can't be reached. */
export async function callApi(base, token, path, { method = "GET", json } = {}) {
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
