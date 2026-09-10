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
still binds 8787. Pass wrangler flags through with `--`, e.g. `npm run dev -- --remote`.

Open the editor at **http://localhost:8787/dashboard/** (the old `/admin/` path
301-redirects there). Locally there's nothing to sign in with — the editor mints its
own dev token on load and shows a **Local dev** chip.
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

This resets the local database and loads a realistic dataset — a back-catalog of
sent issues, one scheduled issue with a live countdown, a couple of drafts, and an
audience covering every subscriber state — so the editor and archive look populated.
It's a thin wrapper around a dev-only `POST /api/dev/seed` route that is available
**only under the fake transport**, so it can never touch a deployed database. Re-run
it any time to reset to a known state.

The sample cover photo lives at `scripts/seed-assets/kestrel.jpg`; if it's missing,
the seed still runs (that one image just 404s until you drop the file in and re-seed).
View the result at `/dashboard/` and at the archived issues, e.g.
**http://localhost:8787/newsletter/the-hovering-hunter**.

> **Note:** the local D1 tracks which migrations it has applied by filename. If the
> migrations ever change, reset the local database — delete this checkout's
> `.wrangler/state` (or run `npm run dev` in a fresh clone) and re-migrate.

## Auth — one contract, different credentials per environment

The admin/authoring surface (the editor, `/posts`, `/sends`, `/subscribers`,
`/suppressions`, `/api/settings`, `/api/docs`, schedule/send) is protected. The
reader routes (`/` archive index, `/subscribe`, `/confirm`, `/unsubscribe`,
`/newsletter/*`, `/media/*`) are public and gated only by unguessable
per-subscriber tokens.

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

In deployed environments the gate is **Cloudflare Access**, enforced at the edge
before the Worker runs — the same pattern used across our other Cloudflare projects.
Deployed envs don't declare `DEV_AUTH_SECRET`, so the dev path is off and Access is the
only way in. The editor needs no token here: the browser's Access session cookie
authenticates every same-origin call, and the sidebar shows your identity plus a
**Sign out** link (`/cdn-cgi/access/logout`).

- **You (human):** an Access **Allow** policy (Google / GitHub / one-time PIN).
  Optionally set `ACCESS_ALLOWED_EMAILS` (CSV) to allowlist specific admin emails.
- **Claude / automation:** an Access **Service Auth** policy with a **service token**
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) — service tokens don't consume
  Zero Trust seats and don't require a browser handshake. This is the credential a
  Claude Desktop connector carries. (An agent-native alternative, Cloudflare Managed
  OAuth for Access, is tracked for later — see `docs/SPEC.md` §10.)
- **Terminal access** to Access-gated endpoints: use `cloudflared`
  (`cloudflared access curl …` / `cloudflared access token …`) rather than a bearer.

The Worker re-verifies the `Cf-Access-Jwt-Assertion` JWT itself (`src/auth/access.ts`,
via `jose` — checks issuer, the app's `ACCESS_AUD`, and the optional email allowlist)
as defense-in-depth, so a misconfigured Access policy can't silently expose admin
routes. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (and optionally
`ACCESS_ALLOWED_EMAILS`) as Worker vars/secrets. The Access application's path scope
must cover **both** the editor SPA (`/dashboard/*`) and the authoring API paths, so
the editor's same-origin API calls carry the Access JWT. (Keep the old `/admin`
prefix in the path list too until every bookmark has followed the 301.)

## Deploying and operating

Local dev is above; standing up a real instance — provisioning Cloudflare, the one Access application, connecting SES/Resend and its webhook, sending-domain DNS, wiring the archive to a website, and a verify checklist — is the **operator setup guide** under [`docs/setup/`](docs/setup/). Those are out-of-band, run-once steps against your own account, DNS, and provider.

The same guide is available **in the editor** under the **Docs** tab: it renders the `docs/setup/` Markdown read-only (the repo is the source of truth), served by the authed `GET /api/docs` routes and gated with the rest of admin.

## Settings

The editor's **Settings** tab holds the app's runtime preferences (via the authed `GET`/`PUT /api/settings`) — currently the default **test recipients** the *Send test email* flow pre-fills. It also shows a **read-only** reflection of the deploy-time configuration (active provider, From address, origins, auth mode) with a link to the Docs. Settings hold preferences only — the provider choice, credentials, Access config, and origins stay in env/secrets and are never readable or writable through the API.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | launcher around `wrangler dev` (local Worker on :8787; auto-migrates a fresh local DB, honors preview `PORT`) |
| `npm run seed` | load the local "Field Notes" demo dataset (needs `npm run dev` running; fake transport only) |
| `npm test` | Vitest suite (runs inside `workerd`) |
| `npm run typecheck` | `wrangler types` + `tsc --noEmit` |
| `npm run check` | Biome: format + organize imports + lint, applying safe fixes (`npm run lint` / `npm run format` for report-only / format-only) |
| `npm run assets:build` | fingerprint the admin assets — stamp a content hash onto the `styles.css` / `app.js` refs in `public/dashboard/index.html` (`assets:check` verifies, and runs before `npm test`) |
| `npm run migrate:local` / `migrate:remote` | apply D1 migrations |
| `npm run deploy` | `wrangler deploy` |

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

```
src/
  index.ts        Worker entry: fetch (router) + scheduled (send sweep)
  router.ts       minimal URLPattern router + middleware
  auth/           Cloudflare Access JWT + dev-signed token (local) → one Principal
  routes/         posts, images, render actions, subscribers, suppressions,
                  public (subscribe/confirm/unsubscribe), sends, archive,
                  settings, docs
  render/         the single render path (markdown → email HTML + text)
  send/           freeze/schedule/cancel, the idempotent send loop, the sweep
  providers/      the email provider seam + fake / SES / Resend adapters
  docs/           the in-app operator guide (bundled from docs/setup/*.md)
  db/             D1 query modules
public/dashboard/ the editor SPA (static assets; /admin/ 301-redirects here)
docs/setup/       the operator setup guide (source of truth; also served in-app)
migrations/       D1 schema
```

## The theme

The editor and reader pages adapt automatically to the viewer's light/dark
preference (`prefers-color-scheme`); no toggle, nothing to configure.

## Admin asset caching

The editor's two static assets (`public/dashboard/styles.css`, `app.js`) are fingerprinted: `scripts/stamp-admin-assets.mjs` stamps a content hash onto their `?v=` in `index.html`, and `public/_headers` caches those hashed URLs immutably. A changed asset gets a new hash — hence a new URL — so it's fetched fresh with no manual version bump. The stamp runs on `npm run dev` startup; `npm test` runs `assets:check` first, so an unstamped commit fails the gate. After editing an asset outside a running dev server, run `npm run assets:build`.

## Status

v1 is being built milestone by milestone (see the repo's issues / the `v1`
milestone). The full local core — authoring, rendering, consent, scheduling, the
send loop, the archive, and the editor — is complete and tested against the fake
transport. The SES and Resend adapters and production deployment are the remaining
milestones.
