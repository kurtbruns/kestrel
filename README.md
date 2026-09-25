# Kestrel

Kestrel is a newsletter app for publishers that you self-host on Cloudflare. You write a post in Markdown, preview exactly what the email will look like, schedule it behind a cancelable review window, and send it to a double-opt-in list. Kestrel holds the list, the consent, the delivery record, and a permanent per-post archive, so you own your audience and your history instead of renting them from a platform.

**Works with Claude.** Kestrel is one HTTP API with two clients: a web editor you drive by hand, and Claude, which drafts, edits, and helps orchestrate scheduling. Neither reaches past the API, so the two never drift out of sync.

**Runs on Cloudflare.** A Cloudflare Worker over D1 (the database) and R2 (images), with a Cron Trigger driving the send sweep, behind a swappable email provider (SES or Resend, plus a fake in-memory transport for local dev and tests).

## Prerequisites

- Node 22+ and npm
- A Cloudflare account, to deploy (not needed for local dev)
- An email provider like **Amazon SES** or **Resend** to send mail once deployed (local dev uses a fake transport that sends nothing)

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars      # ships a working dev setup; no edits needed
npm run dev                         # wrangler dev on http://localhost:8787
```

`npm run dev` applies the D1 migrations automatically on a fresh local database, so there's no separate migrate step. Locally the email transport is a dead-end fake, so nothing you do can reach a real inbox. Open the editor at **http://localhost:8787/dashboard/**. There's nothing to sign in with locally: the editor mints its own dev token and shows a **Local dev** chip, and the preview (which opens at `/`) carries an **Open dashboard** shortcut, so you're one click from the editor.

Local sends behave as deployed ones do. `npm run dev` runs the send sweep once a minute, on the minute, as the deployed cron does, so a scheduled send fires and a paused one resumes without anything run by hand. The shipped dev setup sets the minimum lead, the cancelable window before every send, to one minute (`MIN_LEAD_SECONDS`), the floor every environment shares (deployed, it defaults to five), so a send scheduled a minute out fires one to two minutes later. And on a send to the list, a simulation stands in for a real provider (`SIMULATE_SENDS`, Resend by default; `ses` for Amazon SES, with its wedged sends and quota): batches go out at that provider's pace, now and then one fails the way that provider's do, and receipts (delivered, bounced, complained) arrive after the send, every few seconds, whether or not a page is open. Test sends and confirmation emails skip the simulation and land in the dev outbox (`GET /api/dev/outbox`). `.dev.vars.example` explains each setting; set one in the shell for a single run, for example `SIMULATE_SENDS=ses npm run dev`.

Everything the editor does is on the HTTP API; the editor is just a client of it. Because a draft can be open in two tabs or edited by Claude at once, a stale save is rejected rather than clobbering the newer one (see `docs/SPEC.md` §4).

### Demo data

Out of the box the app loads empty, the way a new publisher first sees it. To explore it with realistic content, load the demo:

```bash
npm run seed
```

This loads a sample publication called **Field Notes** with example data to show how the application looks in practice. View it at `/dashboard/` and at an archived post like **http://localhost:8787/archive/why-a-kestrel**. To inspect it at scale, add a reproducible size (`100` / `1k` / `10k` / `100k`):

```bash
npm run seed -- --size 10k
```

To watch a send go out, schedule one a minute or more ahead and open its watch view:

```bash
npm run simulate-send -- --in 90s
```

It loads the demo first if the database is empty, moves the demo's scheduled post to that time (or schedules a new post), and prints the link to watch it. The server rounds that time up to the whole minute, as it does every fire time, and the send fires at that minute's sweep tick, as deployed. `--profile ses` checks the server simulates SES, and `--punctual` waits for the fire time and runs one extra sweep tick itself.

The dev server's log tells the same send's story as one JSON line per event (`send.fired`, `send.batch`, `send.completed`, and the rest of the catalog in [SPEC §12](docs/SPEC.md#12-failure-posture)). Deployed, the same lines land in Workers Logs, where filtering on a send's `sendId` reads its timeline; [Verify it works](docs/setup/07-verify.md#7-logs) shows how.

Return to the empty first-run state anytime:

```bash
npm run reset
```

## Auth

The admin surface (the editor and the authoring API) is protected; the reader routes (the landing page, the archive, subscribe/confirm/unsubscribe, and media) are public, gated by unguessable per-subscriber tokens. There is **one identity contract**: the Worker verifies a signed token and resolves a `Principal` (a `human` with an email, or a `service`). What issues that token differs by environment; the app logic is the same either way.

Locally there's no sign-in edge, so the editor mints its own dev token (signed with `DEV_AUTH_SECRET`, which ships in `.dev.vars.example`, so the `cp` step above is all the setup). To call the API yourself, mint one (no `email` makes it a `service` principal, like Claude in production):

```bash
TOKEN=$(curl -s http://localhost:8787/api/dev/token?kind=service | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/posts
```

Deployed, the gate is Cloudflare Access instead; that setup is in the [setup guide](docs/setup/).

## Going further

- **Deploy a real instance:** start with [`docs/setup/00-overview.md`](docs/setup/00-overview.md); the whole guide is also served read-only in the editor's Docs tab.
- **Understand the code:** [`.claude/CLAUDE.md`](.claude/CLAUDE.md), kept fresh as the code moves.
- **What Kestrel guarantees, and how the admin UI is built:** [`docs/SPEC.md`](docs/SPEC.md) and [`docs/DESIGN.md`](docs/DESIGN.md).
- **Release history:** [`CHANGELOG.md`](CHANGELOG.md). A deployed instance shows its own version in the editor and at `GET /api/version`; [`docs/setup/09-upgrade.md`](docs/setup/09-upgrade.md) says how to move it to a newer release.
- **All scripts:** `package.json`.

## License

Kestrel is open source under the [MIT License](LICENSE). Copyright (c) 2026 Kurt Bruns.
