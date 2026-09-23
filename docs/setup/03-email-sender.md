# Connect an email sender

Kestrel treats the email provider as **transport** behind a two-method seam (`sendBatch` + `parseWebhook`); the app owns the list, consent, deliveries, and suppressions itself (`docs/SPEC.md` §10). Two adapters ship: **SES** (the default) and **Resend**. Pick one per environment with the `PROVIDER` var and set that provider's credentials as Worker secrets. Every secret a provider's section below sets is required: with `PROVIDER` set to that provider and one missing, the app refuses every request with an error naming it (see **Provision**) rather than failing at the first send.

The webhook is what closes the loop: a hard bounce or a complaint arrives from the provider and suppresses the address on its own. Set it up — a sender without a working bounce/complaint webhook degrades its own deliverability.

## The staging rule

Staging must not be able to mail a stranger. Use the provider's **sandbox** (SES) or a **test domain**, and send only to addresses **you own and have verified**. Real subscribers belong to production only. (Development can't reach an inbox at all — it runs the `fake` transport.)

---

## Option A — Amazon SES

SESv2 `SendEmail` over HTTPS, SigV4-signed (`src/providers/ses.ts`). Events arrive through SNS.

### 1. Verify the sending identity

In the SES console (in your `AWS_REGION`), verify the **domain** `send.example.com` as a sending identity — a domain identity, not just a single address, so any `…@send.example.com` From works and DKIM can be domain-signed. Verifying a domain requires publishing DNS records; do that in **Sending-domain DNS** next.

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

   > **Set `SNS_TOPIC_ARN` (step 4) and deploy before you add the subscription.** SNS signs messages for every topic in every AWS account, so a valid signature alone does not prove a message is yours: the app accepts only messages whose topic is exactly `SNS_TOPIC_ARN`, and refuses everything while it is unset. If the subscription was added first, it stays *Pending confirmation*; once the secret is deployed, select it in the SNS console and choose **Request confirmation**.

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

## Option B — Resend

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

## After either provider

Redeploy so the new `PROVIDER` and secrets take effect:

```bash
npm run deploy -- --env production
```

Then prove the whole round-trip — a real test send, one-click unsubscribe, and a bounce that suppresses — in **Verify it works**.
