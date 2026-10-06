# Use Amazon SES instead of Resend

Amazon SES costs less than Resend at scale, but takes more setup and wants the Workers Paid plan. Follow this page in place of **Connect Resend**, then carry on with **Verify it works**. To move an instance that already sends through Resend, read **Switching providers** at the end first.

## How fast SES sends

A send goes out a slice at a time, one slice a minute, and each slice stays inside what Cloudflare allows one Worker invocation (`SUBREQUEST_BUDGET`, see **Configuration**). Resend takes up to 100 recipients per request; SES takes one, which costs far more of that allowance per recipient:

- **Workers Free:** about 18 recipients a minute, so a send to 1,000 subscribers takes about an hour.
- **Workers Paid, with `SUBREQUEST_BUDGET` set to `10000`:** as fast as your SES account allows, up to about 1,900 recipients a minute. At a new production account's 14 a second, that is about 700 a minute, so 10,000 subscribers take about fifteen minutes. Ask AWS to raise the rate, and set `SES_MAX_SEND_RATE` to match, to go faster.

On Workers Free, use Resend.

## 1. Verify your sending domain

In the SES console, in the region you will send from, verify the **domain** `send.example.com` as a sending identity: a domain, not a single address, so any address on it works and DKIM signs for the whole domain. Turn on Easy DKIM, and publish the three CNAME records the console lists in your Cloudflare zone, exactly as listed:

```
<token1>._domainkey.send.example.com.  CNAME  <token1>.dkim.amazonses.com.
<token2>._domainkey.send.example.com.  CNAME  <token2>.dkim.amazonses.com.
<token3>._domainkey.send.example.com.  CNAME  <token3>.dkim.amazonses.com.
```

Add the DMARC record from **Connect Resend**, step 1, as well. SES sends with its own return path, so SPF passes for `amazonses.com` rather than your domain; DMARC still passes through DKIM. To align SPF too, set a custom MAIL FROM domain, as **Sending-domain DNS** in the reference describes.

## 2. Request production access

A new SES account starts in the **sandbox**: it can send only to addresses you have verified in SES, at one message a second. That is enough for **Verify it works** once you verify your own address in SES, so you can run the checks while AWS reviews your request. Request **production access** from the SES console (Account dashboard → Request production access), and wait for approval before you share the subscribe link.

## 3. Wire the bounce and complaint webhook

SES reports events through SNS:

1. Create an **SES configuration set**. The app attaches it to every send so that events are published.
2. Create an **SNS topic** for the events.
3. In the configuration set, add an **event destination** to SNS and your topic, for at least **Bounce** and **Complaint** (and **Delivery**, if you want delivery receipts).

Leave the subscription to the app for step 5: the app has to be running on SES to confirm it.

## 4. Give the app its credentials

Create an IAM user allowed to call SESv2 `SendEmail`, then set:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env production
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
npx wrangler secret put SES_CONFIGURATION_SET --env production   # the configuration set from step 3
npx wrangler secret put SNS_TOPIC_ARN --env production           # the topic from step 3; the app accepts events only from it
```

In the `production` vars of `wrangler.jsonc`, set `PROVIDER` to `ses`, and `AWS_REGION` to the region from step 1 if it isn't `us-east-1`. While the account is in the sandbox, also add `"SES_MAX_SEND_RATE": "1"`; raise it when AWS raises your rate. On Workers Paid, add `"SUBREQUEST_BUDGET": "10000"`. Commit, and deploy:

```bash
npm run deploy -- --env production
```

The two AWS keys, `SNS_TOPIC_ARN`, and `AWS_REGION` are required: with one missing, the app answers every request with a `500` naming it. `SES_CONFIGURATION_SET` is optional to the app, but without it SES publishes no events and bounces never reach the webhook.

## 5. Subscribe the app to the topic

On the SNS topic, add an **HTTPS subscription** to:

```
https://newsletter.example.com/webhooks/ses
```

SNS immediately sends a confirmation request, and the app confirms it on its own after checking the signature and that it came from your topic. There is nothing to click: the subscription turns **Confirmed** by itself. If it stays **Pending confirmation**, the app was not yet running on SES when you added it; select it and choose **Request confirmation**.

## Check it

- [ ] **Settings → Email sender** shows Amazon SES as the email provider.
- [ ] The SNS subscription shows **Confirmed**.

Then carry on with **Verify it works**.

## Switching providers

Switch `PROVIDER`, or move to another account on the same provider, only while no send is sending. The dashboard lists any send in progress.

When a request to the provider gets no answer, Kestrel cannot know whether those recipients were mailed. On Resend it sends the request again under the same idempotency key, and Resend drops the copy it already delivered. A different provider or account has never seen that key, so it would deliver them again. That is at most the recipients of the one request the old provider never answered, but each of them would get the post twice, and Kestrel does not guard against it (`docs/SPEC.md`, appendix, *Trusted, not guarded*).

If a send is halted and you want another provider to finish it, either accept that risk, or fix the old provider's account and let the send resume there.
