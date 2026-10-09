/*
 * Running wrangler from the kestrel command.
 *
 * Wrangler runs through Node directly rather than its `.bin` shim, so this works on Windows,
 * where the shim is a `.cmd` that Node will not spawn without a shell. It resolves from the
 * directory the command runs in (an instance's own wrangler), falling back to the one beside
 * this package.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The path of wrangler's CLI script. */
function wranglerCli() {
  // The package exports only its library entry (wrangler-dist/cli.js); the CLI sits beside it.
  let entry;
  try {
    entry = createRequire(join(process.cwd(), "package.json")).resolve("wrangler");
  } catch {
    entry = createRequire(import.meta.url).resolve("wrangler");
  }
  return join(dirname(entry), "..", "bin", "wrangler.js");
}

/** Run wrangler to completion with the terminal attached; resolves its exit status. */
export function runWrangler(args, options = {}) {
  const run = spawnSync(process.execPath, [wranglerCli(), ...args], {
    stdio: "inherit",
    ...options,
  });
  if (run.error) {
    console.error(`[kestrel] could not run wrangler: ${run.error.message}`);
  }
  return run.status ?? 1;
}

/** Run wrangler and capture its output instead of showing it. */
export function captureWrangler(args) {
  return spawnSync(process.execPath, [wranglerCli(), ...args], { encoding: "utf8" });
}

/** Start wrangler as a long-running child (`wrangler dev`). */
export function spawnWrangler(args) {
  return spawn(process.execPath, [wranglerCli(), ...args], { stdio: "inherit" });
}
