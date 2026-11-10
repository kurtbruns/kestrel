# Set up alerts

Kestrel's own emails travel through SES, so two problems can never reach you that way: SES refusing your account, and Kestrel itself stopping. A third, SES down for over an hour, reaches you that way only once SES is back. Two Cloudflare alerts are how you hear about them. Each is a Monitor that reads the app's logs once a minute and emails you when its condition holds. Setting them up takes about ten minutes in the Cloudflare dashboard, with no DNS change and no deploy.

This guide is optional, and recommended for any newsletter people rely on. Without the alerts, the dashboard still shows a refusal when you open it, but nothing tells you Kestrel has stopped. Monitoring of your own that reads the same logs can replace these Monitors or add to them.

In this guide, you create the two Monitors, `SES can't send email` and `Kestrel has stopped`, and send a test alert to prove the first one end to end.

## Before you begin

- Your account ID, which this command prints:

    ```bash
    npx wrangler whoami
    ```

- Your Worker's name, the `name` in the `production` block of `wrangler.jsonc`.

## 1. Create the SES alert

This Monitor emails you when SES stops sending Kestrel's email, such as when SES refuses your account or has been down for about an hour. Name each Monitor after the publication and the problem, such as `Field Notes: SES can't send email`. The alert email is plain text, and it shows the name but not the description.

1. In the Cloudflare dashboard, go to **Alerts** > **Monitors**, and select **Create a Monitor**.

1. Choose **Threshold**, then **Custom SQL**, and paste this query, with `ACCOUNT_ID` and `WORKER_NAME` replaced by your two values:

    ```sql
    SELECT count() AS value FROM logs.workersLogs
    WHERE accountTag = 'ACCOUNT_ID'
      AND scriptName = 'WORKER_NAME'
      AND attributes['event'] = 'alert.sending'
    ```

1. Set it to fire when the value is `>= 1`, as an **Average** over `1m`, and to **Run every** `1m`.

1. Name it, such as `Field Notes: SES can't send email`. For its description, which the dashboard shows, you can use this:

    ```
    Amazon SES has stopped sending the newsletter's email. Resolved doesn't mean fixed, so check the dashboard.
    ```

1. Add your email address as its destination, and select **Create**.

## 2. Create the stopped alert

This Monitor emails you when Kestrel stops running the once-a-minute schedule that sends posts.

1. Create a second Monitor the same way, with this query:

    ```sql
    SELECT count() AS value FROM logs.workersLogs
    WHERE accountTag = 'ACCOUNT_ID'
      AND scriptName = 'WORKER_NAME'
      AND attributes['event'] = 'sweep.tick'
      AND attributes['ok'] = true
    ```

1. Set it to fire when the value is `< 0.5`, as an **Average** over `15m`, and to **Run every** `1m`.

1. Name it, such as `Field Notes: Kestrel has stopped`. For its description, you can use this:

    ```
    The newsletter's once-a-minute schedule has stopped, so scheduled posts aren't going out.
    ```

1. Add your email address, and select **Create**.

This Monitor can't be tested without stopping the app. If Kestrel stops, its email arrives about fifteen minutes later, and a `[Resolved]` email about as long after Kestrel is running again.

## 3. Send a test alert

Cloudflare's own **Test** button sends sample data, so this is the only way to prove the real path from the app's log to your inbox.

1. Wait a few minutes after creating the SES alert. A new Monitor can miss a line written right after it is created.

1. In the editor, open **Settings → Notifications**, and select **Send a test alert**. Kestrel writes the line the SES alert watches for, with `cause` set to `test`, and changes nothing else.

1. Wait for the alert email. It arrives in about five minutes, from `noreply@notify.cloudflare.com`, with your Monitor's name in its subject. A `[Resolved]` email follows a few minutes later.

    If nothing has arrived after ten minutes, check your spam and other folders, then send the test alert again.

## What the alert emails mean

The two `[Resolved]` emails mean different things:

- For `SES can't send email`, Resolved means no new line was written, not that the problem is fixed. Kestrel writes the line once, when a problem begins, and not again while it lasts, so the Monitor resolves a few minutes after it whether or not anything changed, and you get no reminder. A new line, and a new alert, comes only when a different problem begins, or the same one again after email got out in between. To see whether the problem has cleared, open the dashboard: a refusal of the account shows as the red line at the top saying email isn't going out, a spent quota as a red line naming the held send, and an outage as an amber line naming the waiting send, each linking to its page. Each line goes away once its problem has cleared.
- For `Kestrel has stopped`, Resolved means the once-a-minute ticks have resumed.

Each line the SES alert counts carries a `cause`, which says why email can't get out. Today the causes are:

- the reason SES gave for refusing the account, such as `credentials`, `configuration`, `sender`, or `suspended`
- `quota`, for a send held because the daily sending quota is spent
- `outage`, for a send SES has been unavailable to, or throttling, at every try for about an hour. Nothing is lost and the send resumes on its own once SES answers. Check [AWS's status page](https://health.aws.amazon.com/health/status) for a problem with Amazon SES in your region. Kestrel also emails the publisher at that moment, but that email goes through SES too, so it may arrive only once SES is back. A later outage, after SES answered in between, writes the line again.
- `test`, from **Send a test alert**

A later release can add a cause, and the Monitor alerts on it with no change, since its query counts every `alert.sending` line. Filter on `event` equal to `alert.sending` in the Worker's **Observability** tab to read the causes, as in [Read the logs](../get-started/verify.md#7-read-the-logs). Count over minutes, never a day: over long ranges the log's counts are estimated from a sample.

## Limits

Know these before you rely on the Monitors:

- The SQL API and Monitors are in beta, so their screens and fields can change.
- On the Workers Free plan, Cloudflare stops keeping logs for the rest of the day once the daily allowance is used, until it resets at 00:00 UTC. Until December 1, 2026, that allowance is 200,000 log events a day; from then, it is 0.5 GB a day, shared with traces. Either way it covers the whole Cloudflare account, not this Worker alone, and [Cloudflare's pricing page](https://developers.cloudflare.com/observability/pricing/) has the current terms. With no logs coming in, `Kestrel has stopped` fires falsely until the reset. An idle instance writes about 3,000 log events a day, far under either limit by Cloudflare's published average event size, so this is rare.
- An outage at Cloudflare can silence both the logs and the alerts.
- Kestrel can't see this setup, so the dashboard can't tell you whether the Monitors exist.
- A destination address that isn't on your Cloudflare account may have to be verified with Cloudflare before it receives alerts.

When the test alert reaches your inbox, your instance can tell you about the problems its own emails can't, or can tell only late.
