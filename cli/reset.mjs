/*
 * `kestrel reset`: return the local dev database to a fresh install, the reverse of seed.
 *
 * A thin wrapper around the dev-only `POST /api/dev/reset` route: it mints a local admin token
 * from `/api/dev/token` and POSTs. The Worker does the wipe (all content, subscribers, and
 * settings), so this needs the dev server up. It shows the first-run dashboard and setup
 * checklist an operator meets when they deploy. The target is found as for seed.
 */
import { baseUrl, callApi, devToken, fail } from "./dev-api.mjs";

/** `kestrel reset [port|url]`. */
export async function resetCommand(argv) {
  const base = baseUrl(argv[0]);
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
