---
paths:
  - "client/**"
  - "public/**"
  - "scripts/build-client.mjs"
  - "vitest.config.ts"
---

# Working on the admin SPA

`client/` (TypeScript) and `public/` (index.html, styles.css, _headers, favicon) are the source; `dist/public` is the served tree, gitignored and rebuilt at will. Edit the source, never `dist/`: a hand patch there works until the next build, then vanishes. Nothing tracked carries a build artifact's hash.

## The build

- `scripts/build-client.mjs` emits the served tree: it copies `public/` through (the hand-authored `styles.css`, `_headers`, favicon, served exactly as written; esbuild never touches the stylesheet), bundles `client/main.ts` with esbuild into one framework-free, dependency-free, plain-JS `app.js`, and generates `index.html` from its source with each asset's content hash as its `?v=`. `public/_headers` caches those two paths immutably, so a changed asset is always a new URL. If the source `index.html` loses an asset reference the build fails loud rather than serve a stale asset.
- Stable names with a `?v=`, not esbuild's content-hashed filenames, on purpose: under `wrangler dev` a file added to the assets directory after startup is never served (its path manifest is built once; only the content of files it already knows is read live), so a new filename per rebuild would 404 until the next restart. This is also why `_headers` is static: exact paths, nothing to generate.
- Two flavors. Production (the default, and what a deploy gets) is minified with `__DEV__` false, so dev-only code is compiled out. Dev (`--dev`, or `KESTREL_CLIENT_DEV=1`, which `scripts/dev.mjs` sets for every builder it starts, including wrangler's `build.command`, which takes no flag) is readable with `__DEV__` true. Declare a new build constant in `client/globals.d.ts`. Both flavors link a sourcemap: readable stack traces from a deployed editor are worth the file, which sits behind Access with the rest of `/dashboard`.
- It runs at every entry that needs the tree: `npm run dev` (the watch, which also re-emits on `public/` edits), wrangler's `build.command` (so a bare `wrangler deploy` can never ship a stale tree; `watch_dir` is pinned to `src/` so `wrangler dev` does not double-build client edits), and `pretest` (so the gate proves the tree still builds; the tests themselves never load it). `wrangler types` runs `build.command` too, so a typecheck rebuilds `dist/`; harmless.

## Types and tests

- `client/tsconfig.json` extends the root with the DOM lib and no Worker or Vitest types; `npm run typecheck` runs it as a second program.
- `client/main.ts` is the former app.js moved verbatim under `// @ts-nocheck`. Lift the pragma module by module as the file is split; every new client module is strict from its first line. While the pragma stands, `client/main.ts` alone skips biome's `noImplicitAnyLet` (an override in `biome.json`, deleted with the pragma).
- Client specs (`client/**/*.spec.ts`) run in the `client` Vitest project under happy-dom with file loading off (an inserted `<link>` would otherwise be fetched for real); the Worker suite is the `worker` project on the workerd pool, untouched. Test pure logic against a DOM; nothing here can reach the Worker or its bindings.

## Live reload in the dev flavor

`client/dev_reload.ts` polls the served `index.html` once a second and compares its `?v=` stamps to the ones the page loaded with: a new `app.js` stamp reloads the page (once; a declined leave prompt is not re-asked), a new `styles.css` stamp hot-swaps the `<link>`. It fetches with cache mode `reload` on purpose: `wrangler dev` keeps serving a regenerated `index.html` under its original ETag, so a plain reload would revalidate to a 304 and keep the stale page.
