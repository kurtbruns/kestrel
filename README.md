# Kestrel

Kestrel is a self-hosted newsletter app for publishers. You write an issue in Markdown, preview exactly what the email will look like, schedule it behind a cancelable review window, and send it to a double-opt-in list. Kestrel holds the list, the consent, the delivery record, and a permanent per-issue archive, so you own your audience and your history instead of renting them from a platform.

**Works with Claude.** Kestrel is one HTTP API with two clients: a web editor you drive by hand, and Claude, which drafts, edits, and helps orchestrate scheduling. Neither reaches past the API, so the two never drift out of sync.

**Self-hosts on Cloudflare.** A Cloudflare Worker over D1 (the database) and R2 (images), with a Cron Trigger driving the send sweep, behind a swappable email provider (SES or Resend, plus a fake in-memory transport for local dev and tests).

## Prerequisites

- Node 20+ and npm
- A Cloudflare account (for deploying; not needed for local dev)

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars      # ships a working dev setup; no edits needed
npm run dev                         # wrangler dev on http://localhost:8787
```

`npm run dev` applies the D1 migrations automatically on a fresh local database, so there's no separate migrate step. Open the editor at **http://localhost:8787/dashboard/**. There's nothing to sign in with locally: the editor mints its own dev token and shows a **Local dev** chip, and the preview (which opens at `/`) carries an **Open dashboard** shortcut, so you're one click from the editor.

Everything the editor does is on the HTTP API; the editor is just a client of it. Because a draft can be open in two tabs or edited by Claude at once, a stale save is rejected rather than clobbering the newer one (see `docs/SPEC.md` §4).

### See it with data

Two dev-only commands (dev server running, fake transport) choose what you see:

- **`npm run reset`** — the **new-publisher first run**: an empty install with the setup checklist, what someone sees the moment they stand up their own Kestrel.
- **`npm run seed`** — a **demo publication**: **"Field Notes,"** a newsletter that's been running a while, with a back-catalog of sent issues, one scheduled issue counting down, a few drafts, and a subscriber list covering every state. View it at `/dashboard/` and at an archived issue like **http://localhost:8787/archive/the-hovering-hunter**.

Re-run either any time to reset to that state. To inspect the app at scale, `npm run seed -- --size 10k` builds a reproducible list of that size (`100` / `1k` / `10k` / `100k`).

## Auth

The admin surface (the editor and the authoring API) is protected; the reader routes (the landing page, the archive, subscribe/confirm/unsubscribe, and media) are public, gated by unguessable per-subscriber tokens. There is **one identity contract**: the Worker verifies a signed token and resolves a `Principal` (a `human` with an email, or a `service`). What issues that token differs by environment; the app logic is the same either way.

### Local

There's no sign-in edge locally, so the editor mints its own dev token (signed with `DEV_AUTH_SECRET`, which ships in `.dev.vars.example`, so the `cp` step above is all the setup). To call the API yourself, mint one (no `email` makes it a `service` principal, like Claude in production):

```bash
TOKEN=$(curl -s http://localhost:8787/api/dev/token?kind=service | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/posts
```

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
