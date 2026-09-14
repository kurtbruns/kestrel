#!/usr/bin/env node
/*
 * Reset the local dev database to a fresh install — the reverse of `npm run seed`.
 *
 * A thin wrapper around the dev-only `POST /api/dev/reset` route (fake transport
 * only): it mints a local admin token from `/api/dev/token` and POSTs. The worker
 * does the wipe (all content, subscribers, and settings), so this needs the dev
 * server up (`npm run dev`). Use it to see the first-run dashboard + setup checklist.
 *
 * The target defaults to the port `npm run dev` recorded for this worktree
 * (scripts/dev-port.mjs), so a worktree on a non-8787 port just works; override it
 * with `PORT` or a URL argument: `npm run reset -- 8788`.
 */
import { readDevPort } from "./dev-port.mjs";

function baseUrl() {
  const arg = process.argv[2];
  if (arg) {
    return /^https?:\/\//.test(arg) ? arg : `http://localhost:${arg}`;
  }
  return `http://localhost:${process.env.PORT || readDevPort() || "8787"}`;
}

// Mint a local admin token from the dev-only bootstrap endpoint (404s on any
// non-dev transport, the same guard the reset route itself carries).
async function devToken(base) {
  let res;
  try {
    res = await fetch(`${base}/api/dev/token?kind=service`);
  } catch (err) {
    console.error(`[reset] could not reach ${base}. Is the dev server running? (npm run dev)`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(
      "[reset] /api/dev/token is unavailable — reset only works under the fake transport.",
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[reset] could not mint a dev token: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  return (await res.json()).token;
}

async function main() {
  const base = baseUrl();
  const token = await devToken(base);

  let res;
  try {
    res = await fetch(`${base}/api/dev/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error(`[reset] could not reach ${base}. Is the dev server running? (npm run dev)`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[reset] request failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const { url } = await res.json();
  console.log(
    "[reset] done — the local database is a fresh install (no posts, subscribers, or settings).",
  );
  console.log(`  view the first-run dashboard: ${url || `${base}/dashboard/`}`);
}

main();
