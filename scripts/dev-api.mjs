/*
 * What the dev scripts (seed, reset, simulate-send) share: finding this worktree's dev
 * server, minting a local admin token from it, and calling its API the way any client does.
 *
 * They work only through the running server's HTTP API, never D1 or R2 directly, so what
 * they do is what the editor or Claude could do, and it lands in the database the server
 * is actually serving. The token comes from the dev-only `/api/dev/token` route, which
 * exists only on a local dev server (fake transport, no Access, a loopback origin).
 */
import { readDevPort } from "./dev-port.mjs";

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

/** The dev server's base URL: a URL or port argument, else `PORT`, else the port
 *  `npm run dev` recorded for this worktree (scripts/dev-port.mjs), else 8787. */
export function baseUrl(arg) {
  if (arg) {
    return /^https?:\/\//.test(arg) ? arg : `http://localhost:${arg}`;
  }
  return `http://localhost:${process.env.PORT || readDevPort() || "8787"}`;
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

/** Mint a local admin token, a `service` principal as Claude is in production, or exit
 *  saying why the server can't give one. */
export async function devToken(base, tag) {
  let res;
  try {
    res = await fetch(`${base}/api/dev/token?kind=service`);
  } catch (err) {
    fail(
      tag,
      `could not reach ${base}. Is the dev server running? (npm run dev)`,
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
    fail(tag, `could not mint a dev token: ${res.status} ${res.statusText}`);
  }
  return (await res.json()).token;
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
      `could not reach ${base}. Is the dev server running? (npm run dev)`,
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
