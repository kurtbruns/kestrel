#!/usr/bin/env node
/*
 * Build what the npm package ships: the Worker as compiled JavaScript, its type
 * declaration, and the admin UI, each stamped with this build.
 *
 * An instance repository depends on `@kurtbruns/kestrel` and re-exports its Worker in one
 * line (`export { default } from "@kurtbruns/kestrel";`). Shipping Kestrel's TypeScript
 * source instead would make the instance's own typecheck check Kestrel's source under the
 * instance's compiler settings, which fails, so the Worker ships as one ES module bundle
 * with a hand-written declaration of its two handlers (`src/worker.d.ts`, which the
 * typecheck holds against the real entry in `test/worker_types.ts`).
 *
 * What the bundle carries and what it leaves out:
 *   - The setup guide and the demo publication's Markdown are inlined as text, as
 *     the Markdown Text rule in wrangler.jsonc does for this repository, so an instance's
 *     wrangler config needs no rule for them.
 *   - Every runtime dependency stays an import (the package declares them, so they install
 *     beside it and the instance's wrangler bundles them), the css-inline `.wasm` included:
 *     wrangler compiles a `.wasm` import by default.
 *   - `node:` and `cloudflare:` imports stay imports, for the runtime to provide.
 *
 * The build stamp (SPEC §9) is written first and inlined, so a published package reports
 * the release and commit it was built from, with no install script in an instance. This runs
 * as the `prepare` script: npm runs it before `npm pack` and `npm publish`, when an instance
 * installs Kestrel from a git branch, and on a plain `npm install` in this repository, which
 * is how a fresh checkout gets its stamp. It never runs where the registry's tarball is
 * installed, which carries the output already.
 *
 * Output (gitignored, listed in package.json `files`):
 *   dist/worker/index.js     the Worker
 *   dist/worker/index.d.ts   its declaration
 *   dist/public/             the admin UI, production flavor (scripts/build-client.mjs)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "worker");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Run one of this repository's Node scripts, failing the build when it fails. */
function run(script, env = process.env) {
  const step = spawnSync(process.execPath, [join(ROOT, "scripts", script)], {
    stdio: "inherit",
    env,
  });
  if (step.status !== 0) {
    process.exit(step.status ?? 1);
  }
}

run("stamp-version.mjs");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ["src/index.ts"],
  outfile: join(OUT, "index.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  loader: { ".md": "text" },
  // A package marked external keeps its subpaths external too (the css-inline .wasm).
  external: [...Object.keys(pkg.dependencies ?? {}), "node:*", "cloudflare:*"],
  logLevel: "warning",
  banner: {
    js: `// @kurtbruns/kestrel ${pkg.version}: the Worker, built by scripts/build-package.mjs.`,
  },
});
copyFileSync(join(ROOT, "src", "worker.d.ts"), join(OUT, "index.d.ts"));
console.log(`[package] dist/worker  v${pkg.version}`);

// The production flavor, whatever the shell asked of a dev build.
const { KESTREL_CLIENT_DEV: _, ...env } = process.env;
run("build-client.mjs", env);
