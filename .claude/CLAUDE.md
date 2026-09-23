# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kestrel is a self-contained newsletter app: write a post in Markdown, preview it exactly as the email, schedule it behind a cancelable review window, and send it to a double-opt-in list — the app owns the list, the consent, the delivery record, and a permanent per-post archive. One HTTP API with two clients (a web editor and Claude); neither reaches past the API.

It runs on a **Cloudflare Worker** over **D1** (database) and **R2** (images), with a **Cron Trigger** driving the send sweep, and a swappable email provider behind a two-method seam: `ses` (events via SNS) and `resend` ship as the two real transports, and a `fake` in-memory transport stands in for local dev and tests. TypeScript under `strict`; runtime deps are `marked`, `jose`, and `aws4fetch`.

`docs/SPEC.md` is the contract — the invariants (I1–I6), the model, and the intended behavior. Read it before changing sending, consent, the record, or the reader surface, and keep it in sync (below).

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

Quality gate before finishing: `npm test`, `npm run typecheck`, and `npm run check`. Biome (`biome.json`) is the formatter + linter, on the same config as the sibling Worker projects. CI runs the same gate on every pull request (`.github/workflows/gate.yml`), and the Protect main ruleset requires it before a merge; still run it by hand before pushing, since CI only tells you afterwards. `npm run deploy` deploys by hand, per environment (through npm, not a bare `wrangler deploy`, so the build stamp below is fresh). `wrangler types` regenerates `worker-configuration.d.ts` (gitignored), so run `typecheck` after touching `wrangler.jsonc`.

The `recommended` preset is enforced at `error` everywhere; the tree is lint-clean. Two deliberate carve-outs: an `overrides` block turns off `noNonNullAssertion` + `noExplicitAny` for the specs only (`test/**`, `client/**/*.spec.ts`, `shared/**/*.spec.ts`; tests legitimately assert known fixture shapes and type parsed JSON as `any`, and both stay enforced in `src/` and the client modules), and four intentional exceptions in `public/dashboard/styles.css` carry inline `biome-ignore` notes (the two deliberate `!important` rules and two descending-specificity selectors, where the cascade is decided by specificity, not source order). Reach for `unwrap(value, what)` (`src/lib/unwrap.ts`) instead of `!` for a row read back right after writing it — it fails loud with a name.

The top-level `wrangler.jsonc` is the **development** environment (fake transport, so dev can never reach a real inbox); `staging` and `production` are named `env`s that **must redeclare** their bindings and vars — wrangler does not inherit them.

## How the code is organized

One Worker (`src/index.ts`): `fetch()` dispatches through a small URLPattern router (`src/router.ts` + `src/app.ts`); `scheduled()` runs the send sweep once a minute. Read `src/` for the layout — these are the rules that aren't obvious from it:

- **`src/app.ts` is the one place routes are registered and the public-vs-gated line is drawn.** The admin surface (editor + authoring API) is wrapped in `requireAuth`; reader routes are public. No public entry point may redirect or link into an Access-gated path.
- **`render/render.ts` is the single render path (I5).** Preview, test, schedule, and send all call it. Never add a second Markdown→email route — a test is only a real test because it's the same code as the send. (The in-app docs viewer is Markdown→*web-page*, a deliberately separate path — see `src/docs/` — so it doesn't count.)
- **`src/docs/` serves the setup guide in-app, read-only.** The Markdown under `docs/setup/` is the source of truth; it's bundled into the Worker as text modules (the `rules` entry in `wrangler.jsonc`, which works under both `wrangler dev` and the Vitest pool) and rendered through the low-level `markdownToHtml` util + the hygiene pass, themed by `lib/page.ts`. The pages are not editable in the app; edit the repo Markdown. Served by the authed `/api/docs` routes and fetched by the SPA (so the dev token / Access session credential is attached, via `authHeaders()`) — never a top-level navigation.
- **`send/` owns the send state machine.** `schedule.ts` freezes the render onto a `sends` row and soft-locks the post (I3, I6); `loop.ts` delivers in batches and marks each recipient in `deliveries` as accepted, so a retry or restart never re-mails anyone (I4), re-sending a batch whose answer it never recorded as the identical batch under the dispatch key saved on its rows; `sweep.ts` fires due sends and raises missed ones loudly; `budget.ts` meters each invocation's D1 statements and provider requests against `SUBREQUEST_BUDGET` (Cloudflare caps them per invocation), so a run stops starting batches while it can still close cleanly and the next tick continues; a lease token confines every lease write and hand-off to the run that holds the send; `remake.ts` re-makes every scheduled send in one guarded batch when the template or an identity field the template renders changes (SPEC §6, §9), after the client acknowledges those sends by id, so no scheduled send is ever on an older look, and the settings routes are its only caller.
- **`providers/` is the transport seam** (`sendBatch` + `parseWebhook`; `fake` is the default in dev/tests). The app owns the list, consent, deliveries, and suppressions, so swapping providers is a swap, not a migration.
- **`auth/` gates the admin surface** with one contract: verify a signed token → `Principal` (`middleware.ts`). Cloudflare Access at the edge, re-verified in-app (`access.ts`), issues it when deployed — human SSO + a service token for Claude; locally a dev-signed token (`dev_token.ts`) stands in, honored only in a dev-shaped env and never committed (`DEV_AUTH_SECRET` lives in `.dev.vars`), so deployed envs are Access-only.
- **`db/` holds all SQL, and nowhere else does.** A variable-length list is bound as one JSON-array parameter (`IN (SELECT value FROM json_each(?))`), never as `?` per item: D1 rejects a statement with more than 100 bound parameters, and local SQLite does not, so only the test guard (`test/support/d1_guard.ts`) would catch it. Until 1.0.0, the self-host release, `migrations/0001_init.sql` is the whole schema and is edited in place: no database anyone would mind rebuilding has run it, so there is nothing to migrate. Because wrangler tracks applied migrations by filename, a change to the baseline means every existing database is rebuilt, not migrated: with `wrangler dev` stopped (a running one keeps the old database file open), delete `.wrangler/state/v3/d1` and run `migrate:local` (`migrate:local` alone sees nothing to apply and the app 500s on the missing column). The baseline freezes at 1.0.0, or earlier the day a database with data worth keeping has run it. From then on `migrations/` is append-only: never edit a shipped migration, add the next one, and mark the freeze here and in the file's header.
- **Config splits along one hard line (SPEC §9).** Deploy-time infrastructure — the provider, its credentials, Access, the origins — lives in env/secrets (`getConfig`, documented in `docs/setup/`) and is NEVER readable or writable through the API. Runtime *preferences* (e.g. default test recipients) live in a singleton settings row (`db/settings.ts`, a JSON blob so a new preference is a code change, not a migration) behind the authed `/api/settings`. The settings surface may *reflect* deploy config read-only, but must never accept or expose a secret.
- **`shared/` is the code both runtimes import, and the only code they share.** Runtime-neutral and dependency-free: no DOM, no Worker types, no import that leaves `shared/`. Both tsconfigs include it, and its specs run in the plain-Node `shared` Vitest project, which is what enforces that. The slug rule and the archive URL formula live here so the editor can never disagree with the Worker about either; the API wire types belong here too, so the compiler checks the contract between the two clients of the API instead of a hand-mirrored copy in `client/`.
- **The admin SPA is built: `client/` and `public/` are source, `dist/public` is the served tree.** `scripts/build-client.mjs` copies `public/` through, bundles `client/main.ts` (the entry) and the modules it imports with esbuild into one plain-JS `app.js`, and generates `index.html` with each asset's content hash as its `?v=` (`public/_headers` caches those URLs immutably), so nothing tracked carries a build artifact's hash. Production is minified with dev-only code compiled out; `npm run dev` builds the readable dev flavor. Client specs run in the `client` Vitest project under happy-dom, beside the untouched workerd `worker` project and the plain-Node `shared` one. App-wide state lives in one object, `appState` (`client/state.ts`); what a view owns lives in the view, for the life of its mount (`client/lifecycle.ts`: a root and an `AbortSignal` per mount, which every timer, poll, and painting read is bound to). Markup is built with the auto-escaping `html` tag (`client/ui/html.ts`) and reaches the document through `setHtml`; `unsafeHtml` is the one escape hatch. The working rules (flavors, wiring, the module layout, the markup rules, the dev live reload) load with the files: `.claude/rules/client.md`.
- **The build stamp is generated, never committed.** `scripts/stamp-version.mjs` resolves the version (`package.json`), short git SHA, the release tag when HEAD sits exactly on one, build time, and repo URL into the gitignored `src/generated/version.ts`; `src/build.ts` adds the commit link, and the release link only for a build that is its own version's tag (so no build ever links to a release it isn't), and is the one source for `GET /api/version` and the settings `deployment.build` reflection (SPEC §9). It runs at every entry point that is a build (`postinstall`, `npm run dev` startup, `predeploy`) and, with `--if-changed`, in `pretest` and `typecheck` so a test run beside a live `wrangler dev` doesn't rewrite a watched file and reload it. Deliberately not a wrangler `build.command`: the build time changes on every run, so under `wrangler dev` that would rebuild-loop. If the file is missing (an `npm ci --ignore-scripts` clone, or `npx vitest` / `test:watch` which skip `pretest`), the import fails loud; run `npm run version:build` once. Build metadata only, so it never passes through `getConfig` or settings.

## The public / admin split

`app.ts` draws the boundary (above), and the self-contained default of SPEC §5 (reader surface) and §11 (domains) is now in code:

- The archive origin and media base default to `APP_ORIGIN` (`src/env.ts`), so a deployment that sets only `APP_ORIGIN` is fully self-contained; the apex archive and a `media.` domain are opt-in overrides.
- `ARCHIVE_BASE_PATH` drives both the emitted URL and the route that serves it — `createRouter(basePath)` in `app.ts`, wired in `src/index.ts` — so the two can't drift.
- `/` is the public archive index (`routes/archive.ts` → `lib/page.ts`), served to everyone and linking only to public pages — never a bounce into the Access-gated `/dashboard`.

## Keep the docs in sync

Changing what the system does, or how the admin UI presents it, means changing the governing document in the same commit: behavior and guarantees in `docs/SPEC.md`, admin-UI presentation in `docs/DESIGN.md`, and `README.md` when the change is visible to whoever runs the app. Code and its docs drifting apart is a bug. The maintainer's rule at `.claude/rules/maintainer.md` says how to write those changes (the level each fact belongs at, the SPEC/DESIGN seam, self-contained rationale); it loads whenever you open one of those files.

A user-facing or operator-visible change also earns a one-line `CHANGELOG.md` entry under `[Unreleased]`, in the same commit, by the same in-sync discipline. `.claude/rules/changelog.md` says which section to use and how to cut a tagged release. A non-blocking `Stop` hook (`.claude/hooks/changelog-reminder.mjs`, wired in `.claude/settings.json`, the repo's only hook) shows the maintainer a reminder in the transcript when a turn ends with code changed and no changelog line (a Stop hook's message reaches the person, not the model), but it is a nudge, never a gate: it can't block a turn, and an internal-only change correctly gets no entry.

## Conventions

- **TypeScript, `strict`.** Prefer real types over `any`. Run `npm run typecheck` before finishing.
- **Keep the module boundaries** (above): SQL in `db/`, the one render path in `render/`, provider-specific code behind the `providers/` seam, the send state machine in `send/`, the admin SPA's source in `client/` and `public/` (never the generated `dist/`), and code both runtimes need in `shared/`, which imports nothing outside itself.
- **Landing a pull request: squash by default.** One gated commit per PR, with the PR's title and description as its message (a repository setting; `.github/rulesets/README.md` records it). Rebase-merge a branch whose commits were shaped on purpose: each a coherent change with its own message, no sync merges. A merge commit only when a branch's merges cannot be replayed and its commits are worth keeping anyway; it puts every sync merge into `main` forever, so rare and deliberate. A stack is a review shape, not a merge shape: build it with rebases, land it in order, squash each, and rebase the next onto the new `main`.
- **A JSON body is read through `readJsonObject` and the field readers in `src/lib/body.ts`**, never `c.req.json()` behind a cast. A wrong shape is a 400 that names the field (in the message and as `field` on the error body); nothing is dropped or defaulted, so a request can't be answered with a 200 that ignored part of it.
- **Secrets** live in `.dev.vars` locally (gitignored; copy `.dev.vars.example`) and in `wrangler secret put` when deployed. Never commit `.dev.vars`.
- **The safety rules are the invariants:** never widen the audience or skip the review window automatically, never add a render path that could differ from the send, never let a retry re-mail an accepted recipient. When in doubt, check `docs/SPEC.md`.

## Comment & doc style

Write for a cold reader — a human and a Claude agent want the same thing. A comment earns its place when it spares the next reader from reconstructing intent, and fails when it restates the code: document the **why**, not the *what*.

- **Markdown prose is unwrapped** — one physical line per paragraph, no hard wrapping at a fixed column (let the editor soft-wrap). Applies to authored/edited prose across `docs/`, `README.md`, `docs/SPEC.md`, and this file. Tables, code fences, and list-item structure keep their own line breaks.
- Every module opens with a short header comment naming its responsibility.
- Non-obvious exported functions/types get JSDoc (`/** … */`) so the summary shows on hover; no `@param`/`@returns` (the `strict` signature already renders it). Trivial one-liners take `//` or nothing.
- No ephemeral references (issue/PR/milestone numbers); point to `docs/SPEC.md`.
