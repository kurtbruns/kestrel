# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kestrel is a self-contained newsletter app: write an issue in Markdown, preview it exactly as the email, schedule it behind a cancelable review window, and send it to a double-opt-in list — the app owns the list, the consent, the delivery record, and a permanent per-issue archive. One HTTP API with two clients (a web editor and Claude); neither reaches past the API.

It runs on a **Cloudflare Worker** over **D1** (database) and **R2** (images), with a **Cron Trigger** driving the send sweep, and a swappable email provider behind a two-method seam (a `fake` in-memory transport for local dev and tests; SES and Resend adapters are still to come). TypeScript under `strict`; runtime deps are `marked`, `jose`, and `aws4fetch`.

`docs/SPEC.md` is the contract — the invariants (I1–I6), the model, and the intended behavior. Read it before changing sending, consent, the record, or the reader surface, and keep it in sync (below).

## Commands

```bash
npm install
cp .dev.vars.example .dev.vars      # then set BEARER_TOKEN (openssl rand -hex 32)
npm run migrate:local               # apply D1 migrations to the local database
npm run dev                         # wrangler dev on http://localhost:8787 (editor at /admin/)

npm test                            # Vitest suite, run inside workerd (@cloudflare/vitest-pool-workers)
npm run test:watch                  # watch mode
npm run typecheck                   # wrangler types && tsc --noEmit
npm run deploy                      # wrangler deploy   (add --env staging | --env production for those)
npm run migrate:remote              # apply D1 migrations to the remote database
```

Quality gate before finishing: `npm test` and `npm run typecheck`. There is no linter/formatter and no CI in the repo — deploy with `wrangler deploy` by hand, per environment. `wrangler types` regenerates `worker-configuration.d.ts` (gitignored), so run `typecheck` after touching `wrangler.jsonc`.

The top-level `wrangler.jsonc` is the **development** environment (fake transport, so dev can never reach a real inbox); `staging` and `production` are named `env`s that **must redeclare** their bindings and vars — wrangler does not inherit them.

## How the code is organized

One Worker (`src/index.ts`): `fetch()` dispatches through a small URLPattern router (`src/router.ts` + `src/app.ts`); `scheduled()` runs the send sweep once a minute. Read `src/` for the layout — these are the rules that aren't obvious from it:

- **`src/app.ts` is the one place routes are registered and the public-vs-gated line is drawn.** The admin surface (editor + authoring API) is wrapped in `requireAuth`; reader routes are public. No public entry point may redirect or link into an Access-gated path.
- **`render/render.ts` is the single render path (I5).** Preview, test, schedule, and send all call it. Never add a second Markdown→email route — a test is only a real test because it's the same code as the send.
- **`send/` owns the send state machine.** `schedule.ts` freezes the render onto a `sends` row and soft-locks the post (I3, I6); `loop.ts` delivers in batches and marks each recipient in `deliveries` as accepted, so a retry or restart never re-mails anyone (I4); `sweep.ts` fires due sends and raises missed ones loudly.
- **`providers/` is the transport seam** (`sendBatch` + `parseWebhook`; `fake` is the default in dev/tests). The app owns the list, consent, deliveries, and suppressions, so swapping providers is a swap, not a migration.
- **`auth/` gates the admin surface.** Cloudflare Access at the edge, re-verified in-app (`access.ts`); the `bearer.ts` fallback is for local/CI — leave `BEARER_TOKEN` unset when deployed so Access is the only door.
- **`db/` holds all SQL, and nowhere else does.** `migrations/` is append-only — never edit a shipped migration, add a new one.

## The public / admin split

`app.ts` draws the boundary (above), and the self-contained default of SPEC §5 (reader surface) and §10 (domains) is now in code:

- The archive origin and media base default to `APP_ORIGIN` (`src/env.ts`), so a deployment that sets only `APP_ORIGIN` is fully self-contained; the apex archive and a `media.` domain are opt-in overrides.
- `ARCHIVE_BASE_PATH` drives both the emitted URL and the route that serves it — `createRouter(basePath)` in `app.ts`, wired in `src/index.ts` — so the two can't drift.
- `/` is the public archive index (`routes/archive.ts` → `lib/page.ts`), served to everyone and linking only to public pages — never a bounce into the Access-gated `/admin`.

## Keep docs/SPEC.md in sync

Any change to sending, consent, the record, or the reader surface updates `docs/SPEC.md` in the same change — code and spec drifting apart is a bug. `README.md` is the user-facing subset; update it when a change is visible to whoever runs the app. Write the spec forward-looking, with no ephemeral references (issue/PR numbers) — state rationale inline; point to `docs/SPEC.md`, never a tracker.

## Conventions

- **TypeScript, `strict`.** Prefer real types over `any`. Run `npm run typecheck` before finishing.
- **Keep the module boundaries** (above): SQL in `db/`, the one render path in `render/`, provider-specific code behind the `providers/` seam, the send state machine in `send/`.
- **Secrets** live in `.dev.vars` locally (gitignored; copy `.dev.vars.example`) and in `wrangler secret put` when deployed. Never commit `.dev.vars`.
- **The safety rules are the invariants:** never widen the audience or skip the review window automatically, never add a render path that could differ from the send, never let a retry re-mail an accepted recipient. When in doubt, check `docs/SPEC.md`.

## Comment & doc style

Write for a cold reader — a human and a Claude agent want the same thing. A comment earns its place when it spares the next reader from reconstructing intent, and fails when it restates the code: document the **why**, not the *what*.

- Every module opens with a short header comment naming its responsibility.
- Non-obvious exported functions/types get JSDoc (`/** … */`) so the summary shows on hover; no `@param`/`@returns` (the `strict` signature already renders it). Trivial one-liners take `//` or nothing.
- No ephemeral references (issue/PR/milestone numbers); point to `docs/SPEC.md`.
