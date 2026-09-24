# Connect an email sender

Kestrel treats the email provider as **transport** behind a two-method seam (`sendBatch` + `parseWebhook`); the app owns the list, consent, deliveries, and suppressions itself (`docs/SPEC.md` §10). Two adapters ship: **Resend**, the simplest to set up, and **Amazon SES**, cheaper at scale. Pick one per environment with the `PROVIDER` var (switching it from the `fake` that **Provision** deployed with) and set that provider's credentials as Worker secrets. Set the secrets first and switch `PROVIDER` last, so the app never runs with a real provider missing its credentials. Each provider's section below names the settings it requires: with `PROVIDER` set to that provider and one of them missing, the app refuses every request with an error naming it (see **Provision**) rather than failing at the first send.

## How fast each provider sends

A send is delivered a slice at a time, one slice per minute, and each slice stays inside the number of database queries and outbound requests Cloudflare allows one Worker invocation (`SUBREQUEST_BUDGET`, see **Provision**). Resend takes up to 100 recipients in one request, so it sends about 450 recipients a minute even on Workers Free. SES takes one recipient per request, so the same budget goes much less far:

- **Workers Free:** about 5 recipients a minute. A send to 1,000 subscribers takes more than three hours.
- **Workers Paid, with `SUBREQUEST_BUDGET` set to `1000`:** about 110 to 140 recipients a minute.

So SES wants Workers Paid. On Workers Free, use Resend.

## The staging rule

Staging must not be able to mail a stranger. Use the provider's **sandbox** (SES) or a **test domain**, and send only to addresses **you own and have verified**. Real subscribers belong to production only. (Development can't reach an inbox at all — it runs the `fake` transport.)

---

## Option A: Resend

Resend's REST API with Svix-signed webhooks (`src/providers/resend.ts`).

### 1. Verify the domain

In the Resend dashboard, add and verify **`send.example.com`** as a sending domain. Verification publishes SPF/DKIM (and a return-path) records — see **Sending-domain DNS**.

### 2. API key

Create a Resend **API key** and set it:

```bash
npx wrangler secret put RESEND_API_KEY --env production
```

### 3. Webhook

In Resend, add a **webhook** pointing at:

```
https://newsletter.example.com/webhooks/resend
```

Subscribe it to the delivery, bounce, and complaint events. Resend signs each delivery with **Svix**; copy the webhook's **signing secret** and set it — the adapter verifies every webhook against it before applying events:

```bash
npx wrangler secret put RESEND_WEBHOOK_SECRET --env production
```

Set `PROVIDER` to `resend` for that environment. `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and `FROM_ADDRESS` are required.

---

## Option B: Amazon SES

SESv2 `SendEmail` over HTTPS, SigV4-signed (`src/providers/ses.ts`). Events arrive through SNS.

### 1. Verify the sending identity

In the SES console (in your `AWS_REGION`), verify the **domain** `send.example.com` as a sending identity — a domain identity, not just a single address, so any `…@send.example.com` From works and DKIM can be domain-signed. Verifying a domain requires publishing DNS records; do that in **Sending-domain DNS** next. That page also covers the optional custom MAIL FROM domain, which is what lets SPF align for SES.

### 2. Leave the sandbox

A new SES account is in the **sandbox**: it can only send to verified addresses and has a tiny quota. For staging that is fine (it matches the staging rule). For production, request **production access** from the SES console (Account dashboard → Request production access) and wait for approval before pointing real subscribers at it.

### 3. Wire the bounce/complaint webhook (config set → SNS → the app)

1. Create an **SES configuration set** and set it as `SES_CONFIGURATION_SET` (below). The adapter attaches it to every send so events are published.
2. Create an **SNS topic** for the events.
3. In the configuration set, add an **event destination** → SNS → your topic, subscribed to at least **Bounce**, **Complaint**, and (optionally) **Delivery**.
4. Add an **HTTPS subscription** on the topic pointing at the app's SES webhook:

   ```
   https://newsletter.example.com/webhooks/ses
   ```

   > The route is `/webhooks/ses` (see `src/routes/webhooks.ts`) — not `/webhooks/email`.

5. **The subscription-confirmation handshake is automatic.** When you add the HTTPS subscription, SNS immediately POSTs a `SubscriptionConfirmation` to the endpoint. The app verifies the SNS signature, checks that the message came from your topic, and completes the handshake for you by fetching the `SubscribeURL` (host-pinned to `sns.<region>.amazonaws.com`); there is nothing to click. The subscription flips to *Confirmed* on its own. Every subsequent event is checked the same way before it touches the database.

   > **Do step 4 first: set the secrets, including `SNS_TOPIC_ARN`, switch `PROVIDER` to `ses`, and deploy, then add the subscription.** Only the SES adapter confirms a subscription; the `fake` transport answers the handshake without confirming it. And SNS signs messages for every topic in every AWS account, so a valid signature alone does not prove a message is yours: the app accepts only messages whose topic is exactly `SNS_TOPIC_ARN`. If the subscription was added first, it stays *Pending confirmation*; once step 4 is deployed, select it in the SNS console and choose **Request confirmation**.

### 4. Credentials and vars

Create an IAM principal allowed to call SESv2 `SendEmail`, then set:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env production
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
npx wrangler secret put SES_CONFIGURATION_SET --env production   # the config set from step 3
npx wrangler secret put SNS_TOPIC_ARN --env production           # the topic ARN from step 3; the webhook accepts only this topic
```

`AWS_REGION` and `FROM_ADDRESS` are public `vars` in `wrangler.jsonc`; set `PROVIDER` to `ses` for that environment. The two AWS keys, `SNS_TOPIC_ARN`, `AWS_REGION`, and `FROM_ADDRESS` are required; `SES_CONFIGURATION_SET` is optional to the app, but without it SES publishes no events and bounces never reach the webhook.

---

## After either provider

Redeploy so the new `PROVIDER` and secrets take effect:

```bash
npm run deploy -- --env production
```

Then prove the whole round-trip — a real test send, one-click unsubscribe, and a bounce that suppresses — in **Verify it works**.
