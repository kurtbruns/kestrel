# Kestrel

A small newsletter app: write an issue in Markdown, preview exactly what the email
will look like, schedule it with a cancelable review window, and send it to a
double-opt-in subscriber list — while owning the list, the consent record, the
delivery record, and a permanent per-issue archive.

One interface (an HTTP API) with two clients: a **web editor** and **Claude**.
Runs on a **Cloudflare Worker** over **D1** (database) and **R2** (images), with a
**Cron Trigger** driving the send sweep, and a swappable email provider (SES or
Resend; a fake in-memory transport for local dev and tests).

## Prerequisites

- Node 20+ and npm
- A Cloudflare account (for deploying; not needed for local dev)

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars      # then edit (see "Auth" below)
npm run migrate:local               # apply the schema to the local D1 (optional; see below)
npm run dev                         # wrangler dev on http://localhost:8787
```

`npm run dev` goes through `scripts/dev.mjs`, a thin launcher around `wrangler dev`.
It applies the D1 migrations automatically the first time a local shadow is empty, so
the `migrate:local` step above is optional. It also honors a `PORT` handed to it by
Claude Code's preview (`.claude/launch.json` has `autoPort`), so parallel worktrees
each get a free port instead of colliding on 8787; a plain terminal `npm run dev`
still binds 8787. It records the port it bound in `.wrangler/dev-port` (gitignored,
per-worktree), so `npm run seed` and `npm run reset` (below) target that same server
automatically — no `PORT` needed even when the worktree isn't on 8787. Pass wrangler
flags through with `--`, e.g. `npm run dev -- --remote`.

Open the editor at **http://localhost:8787/dashboard/**. Locally there's nothing to
sign in with — the editor mints its own dev token on load and shows a **Local dev**
chip. You don't have to type that path: on a local dev instance the public pages
(the landing page at `/` and the archive index) carry a small **Open dashboard**
shortcut in the corner, so the preview — which opens at `/` — is one click from the
editor. That link is dev-only; a deployed public page never links into the editor.
Everything the editor does is also available on the HTTP API — the editor is just a
client of it.

Because a draft can be open in another tab or edited by Claude at the same time, the
editor warns you when a draft changed underneath you rather than silently overwriting
the other version: you can reload to take that version, or keep editing to save over
it. On the API, `PUT /posts/:id` is optimistically concurrent — send the revision you
loaded (an `If-Match` header, matching the `ETag` returned on `GET`, or a
`base_revision` body field) and a stale save is rejected with `409` instead of
clobbering the newer one. See `docs/SPEC.md` §4.

### Load demo data

A fresh database is empty. With the dev server running, load the local
**"Field Notes"** sample newsletter:

```bash
npm run seed
```

This resets the local database and loads a realistic dataset modeled as a
publication that's been running a while: a back-catalog of sent issues whose
audience grew and churned between sends (so each issue's recipient count differs and
reflects the list as it was at that moment), one scheduled issue with a live
countdown, a couple of drafts, and a subscriber list covering every state — plus
suppressions produced by a hard bounce and a spam complaint. So the editor and
archive look populated. It's a thin wrapper around a dev-only `POST /api/dev/seed`
route that is available **only under the fake transport**, so it can never touch a
deployed database. Re-run it any time to reset to a known state.

By default the seed builds a small, story-shaped list (~155 subscribers). To load and
inspect the app at scale — the Sends page, the delivery record, the subscriber roster —
pass an approximate size with `--size` (`100` / `1k` / `10k` / `100k`); a seeded PRNG
keeps the outcomes realistic and makes a given size reproducible, and `--seed` pins it:

```bash
npm run seed -- --size 10k
```

The sample cover photo lives at `scripts/seed-assets/kestrel.jpg`; if it's missing,
the seed still runs (that one image just 404s until you drop the file in and re-seed).
View the result at `/dashboard/` and at the archived issues, e.g.
**http://localhost:8787/archive/the-hovering-hunter**.

To go the other way — wipe the local database back to a fresh install (no posts,
subscribers, or settings) and see the first-run dashboard + setup checklist — run
`npm run reset` (also dev-server-up, fake-transport-only).

> **Note:** the local D1 tracks which migrations it has applied by filename. If the
> migrations ever change, reset the local database — delete this checkout's
> `.wrangler/state` (or run `npm run dev` in a fresh clone) and re-migrate.

## Auth — one contract, different credentials per environment

The admin/authoring surface (the editor, `/posts`, `/sends`, `/subscribers`,
`/suppressions`, `/api/settings`, `/api/docs`, schedule/send) is protected. The
reader routes (`/` landing page, `/archive` + `/archive/*` archive index and
issue pages, `/subscribe`, `/confirm`, `/unsubscribe`, `/media/*`) are public and
gated only by unguessable per-subscriber tokens.

There's **one identity contract** — the Worker verifies a signed token and resolves a
`Principal` (`human` with an email, or `service`). What issues that token differs by
environment; the app logic, the `Principal`, and the tests are the same either way.

### Local: a dev-signed token

There's no Cloudflare Access edge in local dev, so the app verifies a JWT signed with
`DEV_AUTH_SECRET` instead (`src/auth/dev_token.ts`). It ships in `.dev.vars.example`, so
the `cp .dev.vars.example .dev.vars` step above is all the setup there is: the editor
calls `/api/dev/token` on load, stores the minted token, and sends it as
`Authorization: Bearer <jwt>`. (It's kept out of `wrangler.jsonc` on purpose — a
deployed env never gets this value, so the dev auth path stays fail-closed.) To drive
the API yourself, mint one the same way (a token with no `email` is a `service`
principal, mirroring Claude in prod):

```bash
TOKEN=$(curl -s http://localhost:8787/api/dev/token?kind=service | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/posts
```

`DEV_AUTH_SECRET` is honored **only** in a dev-shaped env (fake transport and no Access
configured); `getConfig` drops it otherwise, and `/api/dev/token` 404s once deployed —
so the dev credential is structurally inert in staging/production.

### Deployed (staging/production): Cloudflare Access

Deployed, the gate is **Cloudflare Access** at the edge (the `DEV_AUTH_SECRET` path is off), re-verified inside the Worker (`src/auth/access.ts`) as defense in depth. A human signs in through an Access policy; Claude uses an Access **service token** (the credential a Claude Desktop connector carries). The concrete setup — the Access application, its policies, the service token, and the `ACCESS_*` vars — is in the [setup guide](docs/setup/).

## Deploying and operating

Local dev is above; standing up a real instance — provisioning Cloudflare, the one Access application, connecting SES/Resend and its webhook, sending-domain DNS, wiring the archive to a website, and a verify checklist — is the **setup guide** under [`docs/setup/`](docs/setup/). Those are out-of-band, run-once steps against your own account, DNS, and provider.

The same guide is available **in the editor** under the **Docs** tab: it renders the `docs/setup/` Markdown read-only (the repo is the source of truth), served by the authed `GET /api/docs` routes and gated with the rest of admin.

## Settings

The editor's **Settings** tab holds the app's runtime preferences (via the authed `GET`/`PUT /api/settings`) — currently the default **test recipients** the *Send test email* flows pre-fill (both the post editor's test and the **Email template** page's test, which sends a sample issue through the saved template so you can proof the layout in a real inbox). It also shows a **read-only** reflection of the deploy-time configuration (active provider, From address, origins, auth mode) with a link to the Docs. Settings hold preferences only — the provider choice, credentials, Access config, and origins stay in env/secrets and are never readable or writable through the API.

## Scripts

Every script is in `package.json`. For local dev you need `npm run dev`, `npm run seed`, and `npm run reset` (all above); the quality gate before finishing is `npm test`, `npm run typecheck`, and `npm run check`.

## Environments

Three, each with its own database, storage, and — the load-bearing rule — its own
mail transport, so development can never reach a real inbox:

| | Database | Transport | Access |
| --- | --- | --- | --- |
| dev (local) | local, disposable | **fake** (dead-end) | localhost only |
| staging | separate | provider sandbox → only addresses you own | Cloudflare Access |
| production | real | real SES/Resend, real sending domain | Cloudflare Access |

Set the active transport per environment with the `PROVIDER` var (`fake` / `ses` /
`resend`). Provider credentials and the local `DEV_AUTH_SECRET` live in `.dev.vars`
locally (seeded from `.dev.vars.example`) and in Worker secrets when deployed.

## Project layout

How the code is organized — the module boundaries and the rules that aren't obvious from the tree — is in [`.claude/CLAUDE.md`](.claude/CLAUDE.md), kept fresh as the code moves. This README doesn't restate it.

## The theme

The editor and reader pages adapt automatically to the viewer's light/dark
preference (`prefers-color-scheme`); no toggle, nothing to configure.

## Status

v1 is being built milestone by milestone (see the repo's issues / the `v1`
milestone). The full local core — authoring, rendering, consent, scheduling, the
send loop, the archive, and the editor — is complete and tested against the fake
transport. The SES and Resend adapters and production deployment are the remaining
milestones.
