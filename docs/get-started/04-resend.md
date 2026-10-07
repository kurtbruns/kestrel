# Connect Resend

Kestrel sends your posts through an email provider. The provider only delivers the mail: Kestrel keeps your list, each subscriber's consent, and the record of every send. These guides use Resend. To use Amazon SES instead, follow [Use Amazon SES instead of Resend](../guides/02-ses.md) in place of this page.

In this guide, you verify your sending hostname with Resend and add a DMARC record. Then you give the app an API key and a webhook for bounces and complaints, switch it to Resend, and deploy.

## 1. Verify your sending hostname

Resend sends only from a domain whose DNS proves you own it. These records also let inboxes trust your mail.

1. In Resend, go to [Domains](https://resend.com/domains), select **Add Domain**, and enter `send.example.com`.

1. Select **Sign in to Cloudflare**, and allow Resend to edit your DNS. Resend adds its records to your zone for you.

    To add them by hand instead, copy each record from Resend into your zone's DNS records in Cloudflare. Because your sending hostname is itself a subdomain, some names look doubled, such as `send.send`. That's expected.

1. Leave receiving turned off. Kestrel doesn't receive mail.

1. Wait until Resend shows the domain as **Verified**.

## 2. Add a DMARC record

DMARC tells inboxes what to do with mail that fails its checks, and sends you reports about it. Resend doesn't add this record, so you add it yourself. It starts in monitor mode, which reports without blocking anything.

1. In the Cloudflare dashboard, open your domain's DNS records, and add a record:

    - **Type:** `TXT`
    - **Name:** `_dmarc.send`
    - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1`

1. Replace `dmarc@example.com` with an address that receives mail. Reports arrive there as attachments.

[Sending-domain DNS](../reference/02-sending-domain-dns.md#dmarc-publish-a-policy-and-collect-reports) explains each record, and when to tighten DMARC.

## 3. Create an API key

The app sends through this key. A key that can only send, from only your sending hostname, limits the harm if it ever leaks.

1. In Resend, go to [API Keys](https://resend.com/api-keys), and select **Create API Key**.

1. Fill in the key:

    - **Name:** `kestrel-production`
    - **Permission:** Sending access
    - **Domain:** `send.example.com`

1. Copy the key. Resend shows it only once.

1. Store it as a secret, and paste the key at the prompt:

    ```bash
    npx wrangler secret put RESEND_API_KEY --env production
    ```

## 4. Add the webhook

The webhook tells the app when an address bounces or complains, and the app stops mailing it. Without it, you keep mailing those addresses, and your mail starts landing in spam.

1. In Resend, go to [Webhooks](https://resend.com/webhooks), and select **Add Webhook**.

1. Enter the endpoint URL:

    ```
    https://newsletter.example.com/webhooks/resend
    ```

1. Select these three events, and create the webhook:

    - `email.delivered`
    - `email.bounced`
    - `email.complained`

1. On the webhook's page, copy its signing secret. It starts with `whsec_`.

1. Store it as a secret. The app checks every event against it:

    ```bash
    npx wrangler secret put RESEND_WEBHOOK_SECRET --env production
    ```

## 5. Switch the provider and deploy

Store both secrets before you switch. With `PROVIDER` set to `resend` and a secret missing, every request answers `500` and names the missing secret.

1. In `wrangler.jsonc`, in the `production` block's `vars`, change `PROVIDER` from `fake` to `resend`:

    ```jsonc
    "PROVIDER": "resend",
    ```

1. Commit the change, and push it:

    ```bash
    git commit -am "Send through Resend"
    git push
    ```

1. Deploy:

    ```bash
    npm run deploy -- --env production
    ```

## Check it

1. The app answers on your hostname:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

1. The webhook is public, and refuses a request without Resend's signature:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" -X POST https://newsletter.example.com/webhooks/resend
    ```

    ```
    400
    ```

    Any other answer, such as a redirect to your Cloudflare login, means Access covers the webhook. Remove that path from your Access application.

1. In the editor, **Settings → Email sender** shows Resend as the email provider, and your From address.

The test sends in the next step prove the rest.

Resend's free plan sends up to 100 emails a day and 3,000 a month, test emails included. A list of more than about a hundred subscribers needs a paid plan, listed on [Resend's pricing](https://resend.com/pricing) page. For a large list, [Amazon SES](../guides/02-ses.md) may cost less.

Next, [verify it works](05-verify.md).
