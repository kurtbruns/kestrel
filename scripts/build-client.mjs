#!/usr/bin/env node
/*
 * Build the admin SPA's served tree: public/ + client/ (source) → dist/public (served).
 *
 * public/ is pure source and dist/public is pure output, gitignored and rebuilt at will:
 * nothing tracked ever carries a build artifact's hash. The build copies public/ through
 * (styles.css, _headers, favicon — served exactly as written; esbuild never touches the
 * stylesheet), bundles client/main.ts with esbuild to app.js, and generates index.html
 * from its source with each asset's content hash as its `?v=`. public/_headers caches
 * those two paths immutably, and a changed asset is always a new URL. The browser still
 * receives one framework-free, dependency-free, plain-JS asset.
 *
 * Stable names with a `?v=`, not esbuild's content-hashed filenames, on purpose: observed
 * under wrangler 4.129, `wrangler dev` never serves a file added to the assets directory
 * after startup (a rewritten file is served fresh; a new one 404s until restart), so a new
 * filename per rebuild would kill the dev loop. Wrangler has an assets watcher meant to
 * cover exactly that, so this is its bug rather than its design; stable names are the
 * right production cache shape regardless, so nothing here waits on a fix.
 *
 * Flavors. Production (the default, and what wrangler's build.command produces for a
 * deploy) is minified with `__DEV__` false, so dev-only code such as the live reload is
 * compiled out. Dev (`--dev`, or KESTREL_CLIENT_DEV=1 for wrangler's build.command, which
 * takes no flag; scripts/dev.mjs sets it) is readable with `__DEV__` true. Both link a
 * sourcemap: readable stack traces from a deployed editor are worth the file, which sits
 * behind Access with the rest of /dashboard.
 *
 * Modes:
 *   (default)  build once; exit non-zero on error.
 *   --watch    keep rebuilding: client/ edits through esbuild's incremental context (~10ms),
 *              public/ edits by re-emitting the copied and generated files. Errors are loud
 *              and the previous output stays in place.
 *   --check    prove the tree builds without writing it (the bundle in memory, the source
 *              index.html's asset references verified). For pretest: a second terminal
 *              running the gate beside a live `npm run dev` must not overwrite the dev
 *              tree with the production flavor, which would reload the open editor onto a
 *              bundle with no live reload in it.
 *
 * Only an explicit build (or a deploy) writes the production flavor over a live tree.
 * `wrangler types` runs build.command too, for no reason this script serves (type
 * generation never reads the tree), so it is a no-op here: wrangler names its command in
 * WRANGLER_COMMAND for every custom build.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist", "public");
const ADMIN = "dashboard";

if (process.env.WRANGLER_COMMAND === "types") {
  process.exit(0);
}

const args = process.argv.slice(2);
const dev = args.includes("--dev") || process.env.KESTREL_CLIENT_DEV === "1";
const watchMode = args.includes("--watch");
const checkMode = args.includes("--check");

/** Content fingerprint of a served asset: first 8 hex of its SHA-256. */
const fingerprint = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

/** The assets index.html references with a `?v=`, by the exact reference form it uses. */
const STAMPED = ["app.js", "styles.css"];

/** The source index.html, checked: a template that lost an asset reference would serve a stale asset in production. */
function sourceIndex() {
  const html = readFileSync(join(SRC, ADMIN, "index.html"), "utf8");
  for (const name of STAMPED) {
    if (!html.includes(`./${name}`)) {
      throw new Error(`index.html no longer references ./${name}; the served copy would be wrong`);
    }
  }
  return html;
}

/**
 * Copy public/ through and generate index.html with each stamped asset's `?v=`. Runs after
 * esbuild has written app.js. The exact reference form (`./app.js`) is rewritten, so a
 * prose mention of app.js in a comment is left alone.
 */
function emitServedTree() {
  mkdirSync(join(OUT, ADMIN), { recursive: true });
  cpSync(SRC, OUT, { recursive: true, filter: (src) => src !== join(SRC, ADMIN, "index.html") });
  let html = sourceIndex();
  for (const name of STAMPED) {
    const ref = `./${name}`;
    html = html.replaceAll(ref, `${ref}?v=${fingerprint(readFileSync(join(OUT, ADMIN, name)))}`);
  }
  writeFileSync(join(OUT, ADMIN, "index.html"), html);
}

/** @type {esbuild.BuildOptions} */
const options = {
  absWorkingDir: ROOT,
  entryPoints: ["client/main.ts"],
  outfile: join(OUT, ADMIN, "app.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  sourcemap: true,
  // Icons are files under client/icons/, inlined as text (the client test project mirrors this).
  loader: { ".svg": "text" },
  minify: !dev,
  define: { __DEV__: String(dev) },
  logLevel: "info",
  banner: {
    js: "// GENERATED by scripts/build-client.mjs from client/ — edit the source there, never this file.",
  },
  plugins: [
    {
      name: "emit-served-tree",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            return;
          }
          try {
            emitServedTree();
          } catch (e) {
            console.error(`[client] ${e.message}`);
            if (!watchMode) {
              process.exit(1);
            }
          }
        });
      },
    },
  ],
};

if (checkMode) {
  sourceIndex();
  await esbuild.build({ ...options, write: false, plugins: [], logLevel: "silent" });
  console.log("[client] served tree builds (checked, nothing written)");
} else if (watchMode) {
  const ctx = await esbuild.context(options);
  await ctx.watch();

  // public/ edits (the stylesheet, the index.html template, favicon, _headers) need no
  // bundling, only a re-emit. Watch the directory, not files: an editor that saves by
  // rename replaces the inode, which a file watch would silently lose. Debounced, since
  // one save can land as several events.
  let timer = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        emitServedTree();
      } catch (e) {
        console.error(`[client] ${e.message}`);
      }
    }, 50);
  });

  console.log(
    `[client] ${dev ? "dev" : "production"} flavor — watching client/ and public/, serving from dist/public`,
  );
} else {
  await esbuild.build(options);
}
