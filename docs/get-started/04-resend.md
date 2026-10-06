# Connect Resend

Kestrel sends through an email provider but keeps the list, the consent, and the delivery record itself, so the provider is only the transport (`docs/SPEC.md` §10). This step connects Resend: your sending domain, its DNS, an API key, and the webhook that reports bounces and complaints back to the app. To use Amazon SES instead, follow **Use Amazon SES instead of Resend** and skip to the next step.

## 1. Add your sending domain and its DNS

In the Resend dashboard, add **`send.example.com`** as a domain. Resend lists the DNS records it needs: an MX and an SPF TXT record for its return path, and a DKIM TXT record at `resend._domainkey`. Because your DNS is on Cloudflare, Resend's **Sign in to Cloudflare** button can add them for you. Otherwise, add each one to your zone exactly as listed. Skip the optional inbound MX record: Kestrel receives no mail.

Then add a DMARC record yourself, on the same zone. It starts in monitor mode, which reports without blocking anything:

```
_dmarc.send.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

Wait until Resend shows the domain as **Verified**. DNS can take a few minutes to an hour. **Sending-domain DNS** in the reference explains each record and when to tighten DMARC.

## 2. Create an API key

In Resend, create an **API key** with **Sending access**, limited to `send.example.com`, and give it to the app:

```bash
npx wrangler secret put RESEND_API_KEY --env production
```

## 3. Add the webhook

The webhook is how a bounce or a complaint reaches the app, which then stops mailing that address on its own. Without it you keep mailing addresses that bounce, and your mail starts landing in spam.

In Resend, add a **webhook** pointing at:

```
https://newsletter.example.com/webhooks/resend
```

Subscribe it to the `email.delivered`, `email.bounced`, and `email.complained` events. Copy the webhook's **signing secret** and give it to the app, which checks every event against it:

```bash
npx wrangler secret put RESEND_WEBHOOK_SECRET --env production
```

## 4. Switch the provider and deploy

With both secrets set, change `PROVIDER` in the `production` vars of `wrangler.jsonc` from `fake` to `resend`, commit, and deploy:

```bash
npm run deploy -- --env production
```

Set the secrets before switching: with `PROVIDER` on `resend` and a secret missing, the app answers every request with a `500` naming it.

## Check it

- [ ] The editor loads, and **Settings → Email sender** shows Resend as the email provider, and your From address.

The test send in the next step proves the rest.

Resend's free plan sends at most 100 emails a day and 3,000 a month, test emails included, so a list past about a hundred subscribers needs a paid Resend plan. Kestrel sends up to 100 recipients a request, which comes to about 400 recipients a minute on the Workers Free plan; **Configuration** in the reference says how to go faster on Workers Paid.
