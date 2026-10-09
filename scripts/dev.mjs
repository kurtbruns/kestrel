#!/usr/bin/env node
/*
 * `npm run dev` in this repository: `kestrel dev` (cli/dev.mjs) plus what only a checkout of
 * Kestrel's source needs.
 *
 * The build stamp. Resolved into src/generated/version.ts once, before wrangler starts
 * (scripts/stamp-version.mjs), and deliberately not a wrangler `build.command`: wrangler dev
 * watches src/, and the stamp's build time changes on every run, so a build command would
 * rebuild-loop forever. Best-effort: a stale stamp is harmless.
 *
 * The editor's watch build. The admin UI is served from the tree scripts/build-client.mjs
 * emits (see wrangler.jsonc), in its dev flavor (readable, with the live reload compiled in),
 * asked of every builder this process starts through KESTREL_CLIENT_DEV: the watcher below,
 * and wrangler's own build.command, which takes no flag and inherits this environment. The
 * watcher re-emits the tree as client/ or public/ change (esbuild's incremental watch, ~10ms);
 * wrangler's build.command handles only src/ edits, so exactly one process reacts to a change.
 *
 * Everything else (the sweep ticker, the port, the local database, `.dev.vars`) is the
 * command an instance runs, so the two can't drift.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devCommand } from "../cli/dev.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.KESTREL_CLIENT_DEV = "1";

const version = spawnSync(process.execPath, [join(ROOT, "scripts", "stamp-version.mjs")], {
  stdio: "inherit",
});
if (version.status !== 0) {
  console.warn("[dev] build-version stamp failed (continuing)");
}

const watcher = spawn(process.execPath, [join(ROOT, "scripts", "build-client.mjs"), "--watch"], {
  stdio: "inherit",
});
watcher.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.warn(
      `[dev] client watcher exited (${code}); run \`npm run client:watch\` to restart it`,
    );
  }
});

await devCommand(process.argv.slice(2), { onStop: () => watcher.kill() });
