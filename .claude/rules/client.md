---
paths:
  - "client/**"
  - "public/dashboard/**"
  - "scripts/build-client.mjs"
  - "scripts/stamp-admin-assets.mjs"
  - "vitest.config.ts"
---

# Working on the admin SPA

`client/` is the source; `public/dashboard/app.js` is its build output, gitignored and headed `// GENERATED`. Edit the source, never the bundle: a hand patch to app.js works until the next build, then vanishes.

## The build

- `scripts/build-client.mjs` bundles `client/main.ts` with esbuild into one framework-free, dependency-free, plain-JS IIFE, so the browser receives exactly what it always did. It runs at every entry that needs the bundle: `npm run dev` (once, then an esbuild watch beside wrangler that rebuilds a `client/` edit in ~10 ms and re-stamps `index.html`, also after a `styles.css` save), wrangler's `build.command` (so a bare `wrangler deploy` can never ship a stale bundle; `watch_dir` is pinned to `src/` so `wrangler dev` does not double-build client edits), and `pretest`.
- The build must stay deterministic: no build-time defines, no environment-dependent output. The `?v=` stamp of app.js in `index.html` is committed and is a hash of the bundle's bytes, so anything that varies the bytes between dev and deploy dirties every checkout. Dev-only behavior is gated at runtime instead (the live reload below is the pattern).
- `npm run assets:build` rebuilds and re-stamps by hand; never hand-edit a `?v=`.

## Types and tests

- `client/tsconfig.json` extends the root with the DOM lib and no Worker or Vitest types; `npm run typecheck` runs it as a second program.
- `client/main.ts` is the former app.js moved verbatim under `// @ts-nocheck`. Lift the pragma module by module as the file is split; every new client module is strict from its first line. While the pragma stands, `client/main.ts` alone skips biome's `noImplicitAnyLet` (an override in `biome.json`, deleted with the pragma).
- Client specs (`client/**/*.spec.ts`) run in the `client` Vitest project under happy-dom; the Worker suite is the `worker` project on the workerd pool, untouched. Test pure logic against a DOM; nothing here can reach the Worker or its bindings.

## Live reload in local dev

`client/dev_reload.ts` polls `index.html` once a second for a changed stamp, on only when the boot probe reports auth mode `dev` (no deployed env has it): a new app.js stamp reloads the page, a new styles.css stamp hot-swaps the stylesheet. It fetches with cache mode `reload` on purpose: `wrangler dev` keeps serving a rewritten asset under its original ETag, so a plain reload revalidates to a 304 and keeps the stale page.
