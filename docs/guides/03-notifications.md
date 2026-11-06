# Notifications through Cloudflare's email

Kestrel emails the publisher when a send finishes, and right away when one runs into a problem. By default, these notifications go through the email provider. The one that matters most, about the provider refusing your account, is the one the provider would refuse too. Cloudflare's email doesn't depend on the provider, so that notification still reaches the publisher.

In this guide, you turn on Cloudflare's email for your app's hostname, and verify the notifications addresses with it. Then you add the binding that sends notifications through it, deploy, and send yourself a test.

## Before you begin

You need:

- The notifications addresses saved, from [Verify it works](../get-started/07-verify.md#3-check-that-notifications-arrive).
- Your domain's DNS on Cloudflare, as for the rest of the app.

## 1. Turn on Email Routing for your app's hostname

Cloudflare's email sends only from a domain set up with Email Routing. Use your app's hostname, `newsletter.example.com`. It receives no mail today, so turning Email Routing on there changes nothing else.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Compute → Email Service → Email Routing**.

1. Add `newsletter.example.com` to Email Routing. Cloudflare adds subdomains from your domain's own settings: select `example.com`, then **Settings**, and add `newsletter` under **Subdomains**.

1. Wait until the new row reads **Status: Enabled** and **DNS records: Locked**. Cloudflare adds MX records and an SPF record for `newsletter.example.com`. You may not see a DKIM record for the hostname. The test in [Check it](#check-it) shows whether notifications get through.

Avoid turning on Email Routing for a domain that already receives mail elsewhere, such as `example.com` with Google Workspace. Email Routing takes over that domain's MX records. Don't send notifications from `send.example.com` either, since your email provider sends from it. Email Routing there to forward readers' replies, as [Connect Amazon SES](../get-started/05-ses.md#8-receive-replies-at-your-from-address) sets up, is fine, since it only receives.

## 2. Verify the notifications addresses

Cloudflare's email delivers only to addresses you've verified with it. Sending to a verified address is free on any plan. Notifications can go to several addresses, such as the publisher's and yours, and each one needs verifying.

1. Under **Email Routing**, go to **Destination addresses**, and add each address saved for notifications. An address already verified, such as for forwarding readers' replies, needs nothing more.

1. Open the email Cloudflare sends to each address, and select **Verify email address**. If it's the publisher's address, ask them to do this step.

A verified address belongs to your Cloudflare account, so every environment in it can use it. If the publisher adds or changes a notifications address later, verify the new one too.

## 3. Add the binding and deploy

A `send_email` binding named `NOTIFY` moves notifications to Cloudflare's email. Without it, they go through your provider.

1. In `wrangler.jsonc`, add `send_email` to `env.production`, beside `r2_buckets`. It doesn't go inside `vars`, or at the top level of the file:

    ```jsonc
    "env": {
      "production": {
        // ...
        "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "newsletter-media-production" }],
        "send_email": [{ "name": "NOTIFY" }],
        "vars": {
          // ...
        }
      }
    }
    ```

    Give the binding only its name. This file is committed to your repository, so keep the notifications addresses out of it.

1. **(Optional)** Notifications come from `Kestrel <kestrel@newsletter.example.com>`. To use another address on that hostname, set `NOTIFY_FROM` in `env.production.vars`:

    ```jsonc
    "NOTIFY_FROM": "Kestrel <alerts@newsletter.example.com>",
    ```

1. Check the file. This regenerates the binding types:

    ```bash
    npm run typecheck
    ```

1. Commit the change, and push it:

    ```bash
    git add wrangler.jsonc
    git commit -m "Send notifications through Cloudflare's email"
    git push
    ```

1. Deploy:

    ```bash
    npx wrangler deploy --env production
    ```

    Among the bindings, wrangler lists `env.NOTIFY (unrestricted)`. That's expected, since Cloudflare still delivers only to verified destination addresses. If the line is missing, the binding isn't in `env.production`.

## Check it

1. In the editor, open **Settings → Notifications**. **Sent through** reads "Cloudflare Email, separate from your newsletter's provider", and **From address** shows `Kestrel <kestrel@newsletter.example.com>`.

1. Select **Send a test notification**. It arrives at each notifications address, and **Last notification** shows it as delivered. Check each address's spam folder too. If the test is there, mark it **Not spam**.

If the test isn't delivered to an address, **Last notification** shows Cloudflare's reason, such as an address that isn't verified, after the address when there are several. The other addresses still get it.

To see a notification's status on Cloudflare's side, open Email Routing's **Activity log**, where a delivered one reads **Delivered**. Go by that rather than Email Routing's summary, which [Cloudflare says](https://developers.cloudflare.com/email-service/platform/limits/) can list these emails as dropped even when they're delivered.

## What notifications don't cover

- **The schedule stopping.** The same once-a-minute schedule that sends posts also notices problems. If the schedule itself stops, nothing tells you. [Read the logs](../get-started/07-verify.md#7-read-the-logs) to check that `sweep.tick` still arrives every minute.
- **A notification that can't get through.** The app tries each one up to five times, a minute apart. A failure shows under **Settings → Notifications**, and in the logs as `notify.failed`.
- **Problems while no address is set.** With the address blank, the app sends nothing, and saves nothing up for later.

A notification never changes a send. One that fails never delays, pauses, or stops it.
