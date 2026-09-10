# Operator setup guide

How to take Kestrel from a cloned repo to a live newsletter. This is the **deploy & operate** companion to the two other documents in this repo:

- `docs/SPEC.md` is the contract — what the system guarantees and *why* it is shaped the way it is. Each section below links to it for rationale; the guide itself stays concrete and procedural.
- `README.md` covers local development (the fake transport, the seed data, the local dev-token auth).

Everything here is **operator-run and out-of-band**: you run it once, by hand, against your own Cloudflare account, DNS, and email provider. None of it can be performed from inside the app.

## The shape of a deployment

One deployed Worker answers on one hostname and does everything — the admin editor, the authoring API, the public reader surface (archive index, issue pages, subscribe / confirm / unsubscribe), previews, and image bytes. It is **self-contained by default**: it needs no separate website to be complete (`docs/SPEC.md` §10).

Two names earn their own DNS because they have genuinely different jobs — and the names are deliberately not near-synonyms, so the two can't get swapped:

| Name | Job |
| --- | --- |
| `newsletter.example.com` | the app + reader surface (its own uptime) |
| `send.example.com` | the sending identity — the `From:` address and its SPF/DKIM/DMARC |

There are three environments, each with its own database, storage, and — the load-bearing rule — its own mail transport, so development can never reach a real inbox:

| | Database | Transport | Access |
| --- | --- | --- | --- |
| development (local) | local, disposable | `fake` (dead-end) | localhost only |
| staging | separate | provider sandbox / test domain → only addresses you own | Cloudflare Access |
| production | real | real SES/Resend, real sending domain | Cloudflare Access |

## The order to do this in

1. **Provision the instance** — the Cloudflare account, D1, R2, the Worker, the Cron Trigger, and a first deploy to staging then production.
2. **Access** — the admin gate: one Access application over `/admin/*` **and** the authoring API, an Allow policy for you and a Service Auth policy for Claude.
3. **Connect an email sender** — SES or Resend, and their bounce/complaint webhook.
4. **Sending-domain DNS** — SPF/DKIM/DMARC on `send.example.com`.
5. **Wire the archive to a website** — optional; the self-contained default needs nothing.
6. **Verify it works** — a real test send, one-click unsubscribe, the bounce round-trip, DKIM alignment.

Work through them in that order: staging first, prove it end to end, then repeat the provider and DNS steps for production.

> Throughout, `example.com` / `newsletter.example.com` / `send.example.com` and every `REPLACE_WITH_*` id are placeholders — substitute your own. Secrets are never committed: local ones live in `.dev.vars` (gitignored), deployed ones in `wrangler secret put`.
