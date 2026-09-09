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
npm run migrate:local               # apply the schema to the local D1
npm run dev                         # wrangler dev on http://localhost:8787
```

Open the editor at **http://localhost:8787/admin/**, click the 🔑, and paste your
local admin token (see below). Everything the editor does is also available on the
HTTP API — the editor is just a client of it.

## Auth — the admin token, and how deployed auth differs

The admin/authoring surface (the editor, `/posts`, `/sends`, `/subscribers`,
`/suppressions`, schedule/send) is protected. The reader routes (`/subscribe`,
`/confirm`, `/unsubscribe`, `/newsletter/*`, `/media/*`) are public and gated only
by unguessable per-subscriber tokens.

### Local: a bearer token you generate

There's no Cloudflare Access edge in local dev, so the Worker accepts a **bearer
token** as a fallback. It's a secret *you* generate — there's nothing to fetch:

```bash
openssl rand -hex 32        # copy the output
```

Put it in `.dev.vars` as `BEARER_TOKEN="…"`, restart `npm run dev`, and paste the
same value into the editor's 🔑 field (stored in your browser's `localStorage`).
API calls carry it as `Authorization: Bearer <token>`:

```bash
curl -H "Authorization: Bearer $BEARER_TOKEN" http://localhost:8787/posts
```

### Deployed (staging/production): Cloudflare Access

In deployed environments the gate is **Cloudflare Access**, enforced at the edge
before the Worker runs — the same pattern used across our other Cloudflare projects.
**Leave `BEARER_TOKEN` unset in deployed environments** so Access is the only way in.

- **You (human):** an Access **Allow** policy (Google / GitHub / one-time PIN).
  Optionally set `ACCESS_ALLOWED_EMAILS` (CSV) to allowlist specific admin emails.
- **Claude / automation:** an Access **Service Auth** policy with a **service token**
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) — service tokens don't consume
  Zero Trust seats and don't require a browser handshake.
- **Terminal access** to Access-gated endpoints: use `cloudflared`
  (`cloudflared access curl …` / `cloudflared access token …`) rather than a bearer.

The Worker re-verifies the `Cf-Access-Jwt-Assertion` JWT itself (`src/auth/access.ts`,
via `jose` — checks issuer, the app's `ACCESS_AUD`, and the optional email allowlist)
as defense-in-depth, so a misconfigured Access policy can't silently expose admin
routes. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (and optionally
`ACCESS_ALLOWED_EMAILS`) as Worker vars/secrets. The Access application's path scope
must cover **both** the editor (`/admin/*`) and the authoring API paths, so the
editor's same-origin API calls carry the Access JWT.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `wrangler dev` (local Worker on :8787) |
| `npm test` | Vitest suite (runs inside `workerd`) |
| `npm run typecheck` | `wrangler types` + `tsc --noEmit` |
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
`resend`). Provider credentials and `BEARER_TOKEN` live in `.dev.vars` locally and in
Worker secrets when deployed.

## Project layout

```
src/
  index.ts        Worker entry: fetch (router) + scheduled (send sweep)
  router.ts       minimal URLPattern router + middleware
  auth/           Cloudflare Access JWT + bearer-token fallback
  routes/         posts, images, render actions, subscribers, suppressions,
                  public (subscribe/confirm/unsubscribe), sends, archive
  render/         the single render path (markdown → email HTML + text)
  send/           freeze/schedule/cancel, the idempotent send loop, the sweep
  providers/      the email provider seam + fake / SES / Resend adapters
  db/             D1 query modules
public/admin/     the editor SPA (static assets)
migrations/       D1 schema
```

## The theme

The editor and reader pages adapt automatically to the viewer's light/dark
preference (`prefers-color-scheme`); no toggle, nothing to configure.

## Status

v1 is being built milestone by milestone (see the repo's issues / the `v1`
milestone). The full local core — authoring, rendering, consent, scheduling, the
send loop, the archive, and the editor — is complete and tested against the fake
transport. The SES and Resend adapters and production deployment are the remaining
milestones.
