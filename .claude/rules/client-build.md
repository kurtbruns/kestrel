---
paths:
  - "public/**"
  - "scripts/build-client.mjs"
  - "scripts/dev.mjs"
  - "client/dev_reload.ts"
  - "client/globals.d.ts"
  - "vitest.config.ts"
---

# Building the admin SPA

`scripts/build-client.mjs` turns `public/` and `client/` into the served `dist/public`; its header holds the full reasoning.

## What the build emits

- Edit `client/` and `public/`, never `dist/public`: it is gitignored and rebuilt at will. Nothing tracked carries a build artifact's hash.
- `public/` is copied through as written; esbuild never touches `styles.css`.
- Assets keep stable names, stamped with a content-hash `?v=` in the generated `index.html` and cached immutably by `public/_headers`, a plain static file. Not hashed filenames: `wrangler dev` 404s a file added after startup, so a new name per rebuild would break the dev loop.
- The build fails if the source `index.html` loses its `./app.js` or `./styles.css` reference.

## Production and dev builds

- The production build is the default and what a deploy gets: minified, with `__DEV__` false, so dev-only code compiles out.
- The dev build is readable, with `__DEV__` true. Ask for it with `--dev` or `KESTREL_CLIENT_DEV=1`; `scripts/dev.mjs` sets the variable for every builder it starts, including wrangler's `build.command`, which takes no flag.
- Declare a new build constant in `client/globals.d.ts`.
- Both link a sourcemap: readable stack traces from a deployed editor are worth the file, and it sits behind Access with the rest of `/dashboard`.

## Where the build runs

- `npm run dev` watches `client/` and `public/`. Wrangler's `build.command` runs the build too, so a bare `wrangler deploy` never ships a stale tree, and `watch_dir` leaves `client/` out so `wrangler dev` does not build twice.
- `pretest` runs the build with `--check` (in memory, nothing written), and the build exits at once when `wrangler types` runs it, so a gate run beside `npm run dev` never overwrites the dev build. Only `npm run client:build` or a deploy writes the production build.

## Live reload in the dev build

- `client/dev_reload.ts` polls `index.html` once a second: a new `app.js` stamp reloads the page once (a declined leave prompt is not re-asked), a new `styles.css` stamp hot-swaps the `<link>` so editor state survives.
- It fetches with cache mode `reload` because `wrangler dev` keeps a regenerated `index.html`'s original ETag, so a plain reload would get a 304 and the stale page.

## Icons in the build

- The build inlines icon files with esbuild's `text` loader, and the client tests do the same with the `svg-as-text` plugin in `vitest.config.ts`; keep the two in step.
- The sidebar sprite in `public/dashboard/index.html` is the one icon that isn't a file in `client/ui/icons/`, since it paints before any script runs.
