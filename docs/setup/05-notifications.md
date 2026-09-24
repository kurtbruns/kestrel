# Notifications

Kestrel emails you when a send goes out, and right away if a send runs into a problem, so you are told without having to open the dashboard (`docs/SPEC.md` §8, §12). The first carries the numbers from the send's record and a link to it; the second says what went wrong, with the provider's own words when the provider is the problem, and links to the send.

Each problem is one email per send. One that lasts is not repeated; the dashboard keeps showing it until it clears. The exception is the provider refusing your account: a refusal that clears and later returns is a new one, and gets a new email. A problem that clears before its email could be delivered (while the channel was failing, say) is dropped rather than sent late.

Two things decide where the email goes and how it gets there, and they sit on opposite sides of the line between preferences and deploy config (`docs/SPEC.md` §9):

| | What it is | Where it is set |
| --- | --- | --- |
| **Where** | Your address | In the app: **Settings → Notifications**. An address holds no secret, so it is a preference. |
| **How** | The channel and its sender | Here, at deploy: the `NOTIFY` binding and the optional `NOTIFY_FROM` var. |

## Pick a channel

**Cloudflare's own email (recommended).** With a `send_email` binding named `NOTIFY` declared, notifications go through Cloudflare, not through your newsletter's provider. That independence is the point: the notification you most need, the provider refusing your account, is exactly the one the provider would refuse too. The cost is a one-time setup on Cloudflare: email turned on for one domain, and your address verified as a destination. Both are free on any plan.

**Your newsletter's provider (the fallback).** Without the binding, notifications go through SES or Resend, from your `FROM_ADDRESS`, like a test email. There is nothing to set up, and every notification works except one: when the provider refuses your account, the email about it is refused as well. The refusal still shows on the dashboard, the Sent page, and the send's page, and the failed notification shows under **Settings → Notifications**. On SES in the sandbox, your address must be verified in SES too.

The channel is fixed at deploy; Kestrel never falls back from one to the other mid-send. A notification that fails is retried once a minute, up to five tries, and the failure is shown in Settings and logged as a `notify.failed` event.

Development never reaches a real inbox: locally, notifications go to an in-memory stand-in whatever you declare, show in the `wrangler dev` log as a `notify.sent` event on the `fake` channel, and are listed by `GET /api/dev/outbox`.

## Set up Cloudflare's email

Do this per deployed environment, in the Cloudflare account the Worker runs in. The domain must use Cloudflare DNS.

### 1. Turn on email for a domain that receives no mail

The sender must be an address on a domain onboarded to Cloudflare's email (**Email** in the dashboard: Email Routing, or Email Sending). Use the app's own hostname, `newsletter.example.com`: it receives no mail today, so turning email on there changes nothing else. Avoid a domain that already receives mail elsewhere, such as `example.com`, whose MX records Cloudflare would take over, and avoid `send.example.com`, which is your newsletter provider's sending identity.

By default the sender is `Kestrel <kestrel@newsletter.example.com>`, built from `APP_ORIGIN`. To use another address on an onboarded domain, set `NOTIFY_FROM` in that environment's `vars`:

```jsonc
"NOTIFY_FROM": "Kestrel <alerts@newsletter.example.com>"
```

### 2. Verify your address as a destination

Under **Email → Email Routing → Destination addresses**, add the address you want notifications at. Cloudflare emails it a link; open it and select **Verify email address**. Destination addresses belong to the account, so one verification serves every environment in it. Sending to a verified destination is free and does not count toward any sending quota.

Cloudflare only delivers from the binding to verified destinations (unless you onboard a sending domain to Email Sending, which lets it mail anyone and needs Workers Paid; notifications don't need that).

### 3. Declare the binding

In each deployed environment of `wrangler.jsonc` (`env.staging`, `env.production`; never the top-level development config):

```jsonc
"send_email": [
  { "name": "NOTIFY", "allowed_destination_addresses": ["you@example.com"] }
],
```

`allowed_destination_addresses` is optional. It pins the binding to the addresses you list, so even an admin session that changed the preference could not point notifications anywhere else. Leave it out to allow any verified destination. Then regenerate types and deploy:

```bash
npm run typecheck
npm run deploy -- --env staging
```

## Set the address and send a test

Open **Settings → Notifications**, enter your address, and **Save**. Then **Send a test notification**: it goes to the saved address through the live channel. Settings shows which channel is in use and its sender, and **Last notification** shows whether the latest one, a test included, was delivered or, if not, the channel's own words (an unverified destination, say). A test that gets through after a failure clears it.

Leave the address blank for no notifications. Events that happen while it is blank are not saved up, so setting an address later never delivers a backlog.

## What a notification can't do

- **Tell you the sweep has stopped.** A missed fire time is noticed by the same minute-by-minute sweep that fires sends, so if the Cron Trigger stops running altogether, nothing notices. The notification arrives once the sweep runs again. Confirm the trigger under the Worker's **Triggers** tab (see **Provision the instance**).
- **Change a send.** A notification only reads the send's record. One that fails never delays, pauses, or changes a send.
