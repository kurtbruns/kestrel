---
name: simulate-send
description: Run a simulated newsletter send on the local dev server and open its watch view, for a demo, a journey run, or checking how a send looks in flight. Use when asked to "simulate a send", "demo a send", "send the demo newsletter", watch a send go out locally, or see a send wedge, halt on a quota, or settle its receipts. Covers picking the provider profile (Resend, SES, generic), the fire time, and what to expect on the record view. Not for deployed environments.
---

# Simulate a send

A local send is a real send through the real API, send loop, and receipt ingest; only the provider is simulated, and only for the list (docs/SPEC.md §10). `npm run simulate-send` does the whole setup, so never improvise it: no editing a send's `fire_at` in the local database, no hand-run `curl …/cdn-cgi/local/scheduled`, no new dev route.

## Steps

1. **A dev server must be running** for this worktree. If `npm run simulate-send` says it can't reach one, start it (`preview_start` with the `kestrel-dev` configuration, or `npm run dev`). The launcher runs the send sweep once a minute, on the minute, as the deployed cron does.
2. **Pick the profile** the demo needs. The server's `SIMULATE_SENDS` decides it, fixed at start:
   - `resend` (the shipped default): 100 recipients a request; a lost request is re-sent under its idempotency key. A demo list goes out in one tick.
   - `ses`: one recipient a request, no idempotency key. Each send runs out of its daily quota once (the send halts, "provider refusing the account", and retries five minutes later) and loses one request in flight, so it ends **wedged** until someone uses **Resolve**. On the default `SUBREQUEST_BUDGET` (Workers Free) a local SES send goes out as slowly as a deployed one on that plan (docs/setup/03-email-sender.md has the numbers); start the server with `SIMULATE_SENDS=ses SUBREQUEST_BUDGET=10000 npm run dev` to model Workers Paid.
   - `1` (generic): small, slow batches that are easy to watch fill.
   - Append `:none` (for example `ses:none`) for a clean run: no failures, every receipt a delivery.

   To switch, restart the server with the new value: from a terminal, `SIMULATE_SENDS=ses npm run dev` for one run; for a `preview_start` server, set `SIMULATE_SENDS` (and `SUBREQUEST_BUDGET`) in `.dev.vars`, which is gitignored and local, then stop and start the preview. `--profile` on the script only checks the running server and explains.
3. **Run it:**

   ```bash
   npm run simulate-send -- --in 90s
   ```

   `--in` is how far out the send fires (`90s`, `2m`, `1m30s`); left out, it is the server's minimum lead. It refuses a time inside the lead (one minute in the shipped dev setup, never less anywhere) and says why. It seeds the demo if the database is empty (`--size 1k` to seed a larger list), moves the demo's scheduled post to that time, or schedules a new post once the demo's has gone out, and prints the watch URL `…/dashboard/#/sent/<id>`.
4. **Open the watch URL** in the Browser pane. Tell the person when it will fire: at the first minute tick after its fire time, so one to two minutes after a `--in 60s` request, as deployed. Pass `--punctual` only when they want it on the second (the script waits and runs one extra sweep tick).

## What to expect on the record view

- Before the fire time the watch URL opens the post, scheduled and cancelable (a scheduled send's home is its editor); once it fires, the same URL shows the send. Reload it after the tick if the editor is still open.
- At the tick: the phase moves to progressing (retrying or backing-off on a failure), then the send is **sent** once every recipient is accepted or terminal.
- Receipts arrive on the next ticks: delivered first, then bounces, then (realistic faults) a complaint about a minute later; hard bounces and complaints suppress their addresses.
- SES realistic: needs-attention twice, first the quota (clears on its own at the retry), then the wedge, which **Resolve** clears ("assume sent" if the outbox shows the message went, which it does).
- Test sends and confirmations are never simulated; they appear at once in `GET /api/dev/outbox`, along with every simulated message the list send delivered.

## When something is off

- "isn't simulating sends": the server runs with `SIMULATE_SENDS=off` or an old `.dev.vars` without it; `npm run dev` names missing settings at start. Restart with `SIMULATE_SENDS=resend npm run dev`.
- "inside this server's minimum lead": ask for a later time, or set `MIN_LEAD_SECONDS="60"` in `.dev.vars` and restart (60 is the floor).
- A send that never fires: check the dev server log for `[dev] send sweep: running once a minute`; a server started some other way than `npm run dev` has no ticker.
