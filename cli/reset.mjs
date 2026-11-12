/*
 * `kestrel reset`: return the local dev database to a fresh install, the reverse of seed.
 *
 * A thin wrapper around the dev-only `POST /api/dev/reset` route: it mints a local admin token
 * from `/api/dev/token` and POSTs. The Worker does the wipe (all content, subscribers, and
 * settings), so this needs the dev server up. It shows the first-run dashboard and setup
 * checklist an operator meets when they deploy. The target is found as for seed.
 */
import { commandArgs } from "../packages/kestrel/lib/args.mjs";
import { callApi, connectDevServer, fail } from "../packages/kestrel/lib/dev-api.mjs";

const USAGE = `Usage: kestrel reset [port|url]

  Return the local dev server to a fresh install: no posts, subscribers, or settings.
  With no port or url, it acts only on the dev server this directory's kestrel dev started.`;

/** `kestrel reset [port|url]`. */
export async function resetCommand(argv) {
  const args = commandArgs(USAGE, argv, { max: 1 });
  if (!args) {
    return;
  }
  const { base, token } = await connectDevServer(args.positionals[0], "reset");
  const res = await callApi(base, token, "/api/dev/reset", { method: "POST" });
  if (!res.ok) {
    fail(`request failed: ${res.status}`, JSON.stringify(res.body));
  }
  const { url } = res.body;
  console.log(
    "[reset] done — the local database is a fresh install (no posts, subscribers, or settings).",
  );
  console.log(`  view the first-run dashboard: ${url || `${base}/dashboard/`}`);
  // An open editor tab holds the settings it read when it loaded (the old name and logo).
  console.log("  reload any dashboard tab already open, so it reads the fresh install.");
}
