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

`npm run dev` applies the D1 migrations automatically on a fresh local database, so there's no separate migrate step. Locally the email transport is a dead-end fake, so nothing you do can reach a real inbox. Open the editor at **http://localhost:8787/dashboard/**. There's nothing to sign in with locally: the editor mints its own dev token and shows a **Local dev** chip, and the preview (which opens at `/`) carries an **Open dashboard** shortcut, so you're one click from the editor.

Everything the editor does is on the HTTP API; the editor is just a client of it. Because a draft can be open in two tabs or edited by Claude at once, a stale save is rejected rather than clobbering the newer one (see `docs/SPEC.md` §4).

### See it with data

Two dev-only commands (dev server running, fake transport) choose what you see:

- **`npm run reset`** gives you the **new-publisher first run**: an empty install with the setup checklist, what someone sees the moment they stand up their own Kestrel.
- **`npm run seed`** gives you a **demo publication**: **"Field Notes,"** a newsletter that's been running a while, with a back-catalog of sent issues, one scheduled issue counting down, a few drafts, and a subscriber list covering every state. View it at `/dashboard/` and at an archived issue like **http://localhost:8787/archive/the-hovering-hunter**.

Re-run either any time to reset to that state. To inspect the app at scale, `npm run seed -- --size 10k` builds a reproducible list of that size (`100` / `1k` / `10k` / `100k`).

## Auth

The admin surface (the editor and the authoring API) is protected; the reader routes (the landing page, the archive, subscribe/confirm/unsubscribe, and media) are public, gated by unguessable per-subscriber tokens. There is **one identity contract**: the Worker verifies a signed token and resolves a `Principal` (a `human` with an email, or a `service`). What issues that token differs by environment; the app logic is the same either way.

Locally there's no sign-in edge, so the editor mints its own dev token (signed with `DEV_AUTH_SECRET`, which ships in `.dev.vars.example`, so the `cp` step above is all the setup). To call the API yourself, mint one (no `email` makes it a `service` principal, like Claude in production):

```bash
TOKEN=$(curl -s http://localhost:8787/api/dev/token?kind=service | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/posts
```

Deployed, the gate is Cloudflare Access instead; that setup is in the [setup guide](docs/setup/).

## Going further

- **Deploy a real instance:** the setup guide under [`docs/setup/`](docs/setup/), also served read-only in the editor's Docs tab.
- **Understand the code:** [`.claude/CLAUDE.md`](.claude/CLAUDE.md), kept fresh as the code moves.
- **What Kestrel guarantees, and how the admin UI is built:** [`docs/SPEC.md`](docs/SPEC.md) and [`docs/DESIGN.md`](docs/DESIGN.md).
- **All scripts:** `package.json` (the ones you need for local dev are above).
