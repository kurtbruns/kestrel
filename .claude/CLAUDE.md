# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kestrel is a self-contained newsletter app: write a post in Markdown, preview it exactly as the email, schedule it behind a cancelable review window, and send it to a double-opt-in list. The app owns the list, the consent, the delivery record, and a permanent per-post archive. One HTTP API has two clients, a web editor and Claude, and neither reaches past it.

It runs on a Cloudflare Worker over D1 (database) and R2 (images), with a Cron Trigger driving the send sweep once a minute. Email goes through a swappable provider: `ses` and `resend` are the real transports, and the in-memory `fake` serves local dev and tests. TypeScript under `strict`.

`docs/SPEC.md` is the contract: the invariants (I1 to I6), the model, and the intended behavior. Read it before changing sending, consent, the record, or the reader surface.

## Commands

```bash
npm install
cp .dev.vars.example .dev.vars      # ships a dev-insecure DEV_AUTH_SECRET; the editor mints its own admin token
npm run migrate:local               # apply D1 migrations to the local database
npm run dev                         # wrangler dev on http://localhost:8787 (editor at /dashboard/)

npm test                            # Vitest suite, run inside workerd (@cloudflare/vitest-pool-workers)
npm run test:watch                  # watch mode
npm run typecheck                   # stamps the build (if changed), wrangler types (which also emits dist/), then tsc for both programs
npm run check                       # biome check --write . (format + organize imports + lint, applies safe fixes)
npm run client:build                # emit the served admin tree (public/ + client/ → dist/public) once; client:watch keeps it current
npm run lint                        # biome lint .          (report only, no writes)
npm run format                      # biome format --write .
npm run deploy                      # stamps the build, then wrangler deploy (add --env staging | --env production for those)
npm run migrate:remote              # apply D1 migrations to the remote database
```

- **Quality gate before finishing:** `npm test`, `npm run typecheck`, and `npm run check`. CI runs the same gate on every pull request and `main` requires it, but CI only tells you afterwards, so run it before pushing.
- **Deploy through `npm run deploy`,** never a bare `wrangler deploy`, so the build stamp is fresh.
- **Run `typecheck` after touching `wrangler.jsonc`:** `wrangler types` regenerates the gitignored `worker-configuration.d.ts`.
- **`wrangler.jsonc` top level is the development environment** (fake transport, so dev can never reach a real inbox). `staging` and `production` are named `env`s that must redeclare every binding and var, because wrangler does not inherit them.
- **A failed import of `src/generated/version.ts`** means the build stamp was never generated (an `--ignore-scripts` install, or `npx vitest` skipping `pretest`). Run `npm run version:build` once.
- **The app 500s on a missing column after a pull** when the schema baseline changed. Until 1.0.0, `migrations/0001_init.sql` is edited in place (its header says why and when that stops), so a changed baseline means rebuilding, not migrating: stop `wrangler dev` (it holds the database file open), delete `.wrangler/state/v3/d1`, and run `npm run migrate:local`.

## Lint

Biome's `recommended` preset is enforced at `error` everywhere and the tree is lint-clean. Specs (`test/**`, `client/**/*.spec.ts`, `shared/**/*.spec.ts`) may use `!` and `any`; `src/` and the client modules may not. A deliberate exception elsewhere carries an inline `biome-ignore` that says why. For a row read back right after writing it, use `unwrap(value, what)` (`src/lib/unwrap.ts`) instead of `!`: it fails loud with a name.

## Boundaries the code does not state

The mechanism behind each boundary is in its module's header comment; these are the lines not to cross.

- **`src/app.ts` is the one place routes are registered** and where the public/admin line is drawn. The admin surface (editor and authoring API) is wrapped in `requireAuth`; reader routes are public. No public entry point may redirect or link into an Access-gated path, so `/` is the public archive index, never a bounce into `/dashboard`.
- **`render/render.ts` is the single render path (I5).** Preview, test, schedule, and send all call it. Never add a second Markdown-to-email route: a test is only a real test because it runs the same code as the send. The in-app docs viewer (`src/docs/`) renders the `docs/setup/` Markdown to a web page, a deliberately separate path; the SPA fetches it through the authed `/api/docs` routes, never a top-level navigation.
- **`send/` owns the send state machine,** and no retry or restart may re-mail an accepted recipient (I4).
- **`providers/` is the transport seam** (`sendBatch` + `parseWebhook`). What a provider's error means is decided in its adapter and nowhere else. The app owns the list, consent, deliveries, and suppressions, so swapping providers is a swap, not a migration.
- **`notify/` tells the publisher (SPEC §8, §12).** It reads the send record, writes only its own table, and never runs inside the send loop, so a notification can't change a send.
- **`auth/` gates the admin surface with one contract:** verify a signed token, get a `Principal`. Deployed, Cloudflare Access issues it (re-verified in-app); locally a dev-signed token stands in, honored only in a dev-shaped env (fake transport, no Access, a loopback `APP_ORIGIN`). The same predicate, through `config.devMode`, decides whether the `/api/dev/*` routes are registered at all; never gate dev tooling on the provider name. `DEV_AUTH_SECRET` lives in `.dev.vars` and is never committed.
- **All SQL lives in `db/`,** and nowhere else. Bind a variable-length list as one JSON-array parameter, `IN (SELECT value FROM json_each(?))`, never a `?` per item: D1 rejects a statement with more than 100 bound parameters and local SQLite does not, so only the test guard (`test/support/d1_guard.ts`) would catch it.
- **Config splits along one hard line (SPEC §9).** Deploy-time infrastructure (the provider, its credentials, Access, the origins) lives in env and secrets, read through `getConfig`, and is never readable or writable through the API. Runtime preferences live in the singleton settings row (`db/settings.ts`, a JSON blob, so a new preference is a code change, not a migration) behind the authed `/api/settings`, which may reflect deploy config read-only but never accepts or exposes a secret.
- **`shared/` is the only code both runtimes import.** Runtime-neutral and dependency-free: no DOM, no Worker types, no import that leaves `shared/`; its plain-Node Vitest project enforces that. The slug rule, the archive URL formula, and the API wire types live here, so the editor and the Worker cannot disagree and the compiler checks the contract between them.
- **The admin SPA's source is `client/` and `public/`;** `dist/public` is generated and never edited. `.claude/rules/client.md` holds the rest.
- **The build stamp (`src/generated/version.ts`) is generated by `scripts/stamp-version.mjs`, never committed.** It is build metadata only, so it never passes through `getConfig` or settings.

## Keep the docs in sync

Changing what the system does, or how the admin UI presents it, means changing the governing document in the same commit: behavior and guarantees in `docs/SPEC.md`, admin-UI presentation in `docs/DESIGN.md`, and `README.md` when the change is visible to whoever runs the app. Code and its docs drifting apart is a bug. `.claude/rules/maintainer.md` says how to write those changes and loads with those files.

A user-facing or operator-visible change also earns a one-line `CHANGELOG.md` entry under `[Unreleased]` in the same commit; an internal-only change gets none. `.claude/rules/changelog.md` says which section and how to cut a release.

## Conventions

- **TypeScript, `strict`.** Prefer real types over `any`.
- **Keep the module boundaries** above: SQL in `db/`, the one render path in `render/`, provider-specific code behind `providers/`, the send state machine in `send/`, publisher notifications in `notify/`, the admin SPA's source in `client/` and `public/`, and code both runtimes need in `shared/`.
- **Read a JSON body through `readJsonObject` and the field readers in `src/lib/body.ts`,** never `c.req.json()` behind a cast. A wrong shape is a 400 that names the field (in the message and as `field` on the error body); nothing is dropped or defaulted, so a request is never answered with a 200 that ignored part of it.
- **Secrets** live in `.dev.vars` locally (gitignored; copy `.dev.vars.example`) and in `wrangler secret put` when deployed.
- **The safety rules are the invariants:** never widen the audience or skip the review window automatically, never add a render path that could differ from the send, never let a retry re-mail an accepted recipient. When in doubt, check `docs/SPEC.md`.
- **Land a pull request by squash,** one gated commit with the PR's title and description as its message. Rebase-merge a branch whose commits were shaped on purpose (each coherent, with its own message, no sync merges). A merge commit only when a branch's merges cannot be replayed and its commits are worth keeping anyway, since it puts every sync merge into `main` forever. A stack is a review shape, not a merge shape: land it in order, squash each, and rebase the next onto the new `main`.

## GitHub issues

When the user asks you to change what an issue asks for, rewrite its body instead of adding a comment, since whoever picks it up often reads only the body. Work the change in where it belongs rather than appending, with no "Updated:" line; GitHub keeps the edit history.

## Comment & doc style

Write for a cold reader; a human and a Claude agent want the same thing. A comment earns its place when it spares the next reader from reconstructing intent, and fails when it restates the code: document the **why**, not the *what*.

- **Markdown prose is unwrapped:** one physical line per paragraph, no hard wrapping (let the editor soft-wrap). Tables, code fences, and list-item structure keep their own line breaks.
- Every module opens with a short header comment naming its responsibility.
- Non-obvious exported functions and types get JSDoc (`/** … */`) so the summary shows on hover; no `@param`/`@returns` (the `strict` signature already renders it). Trivial one-liners take `//` or nothing.
- No ephemeral references (issue, PR, or milestone numbers); point to `docs/SPEC.md`.
