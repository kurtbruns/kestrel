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
import { baseUrl, callApi, devToken, fail } from "./dev-api.mjs";

async function main() {
  const base = baseUrl(process.argv[2]);
  const token = await devToken(base, "reset");
  const res = await callApi(base, token, "/api/dev/reset", { method: "POST", tag: "reset" });
  if (!res.ok) {
    fail("reset", `request failed: ${res.status}`, JSON.stringify(res.body));
  }
  const { url } = res.body;
  console.log(
    "[reset] done — the local database is a fresh install (no posts, subscribers, or settings).",
  );
  console.log(`  view the first-run dashboard: ${url || `${base}/dashboard/`}`);
}

main();
