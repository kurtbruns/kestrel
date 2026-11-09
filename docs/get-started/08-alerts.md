# Set up alerts

Kestrel's own emails travel through SES, so two problems can never reach you that way: SES refusing your account, and Kestrel itself stopping. Two Cloudflare alerts are how you hear about them. Each is a Monitor that reads the app's logs once a minute and emails you when its condition holds. Setting them up takes about ten minutes in the Cloudflare dashboard, with no DNS change and no deploy.

You can skip this page for a test or demo instance, or if monitoring of your own already reads the same logs. Without the alerts, the dashboard still shows a refusal when you open it, but nothing tells you Kestrel has stopped.

In this guide, you create the two Monitors, `SES can't send email` and `Kestrel has stopped`, and send a test alert to prove the first one end to end.

## Before you begin

- Your account ID, which this command prints:

    ```bash
    npx wrangler whoami
    ```

- Your Worker's name, the `name` in the `production` block of `wrangler.jsonc`.

## 1. Create the SES alert

This Monitor emails you when SES stops sending Kestrel's email, such as when SES refuses your account. Name each Monitor after the publication and the problem, such as `Field Notes: SES can't send email`. The alert email is plain text, and it shows the name but not the description.

1. In the Cloudflare dashboard, go to **Alerts** > **Monitors**, and select **Create a Monitor**.

1. Choose **Threshold**, then **Custom SQL**, and paste this query, with `ACCOUNT_ID` and `WORKER_NAME` replaced by your two values:

    ```sql
    SELECT count() AS value FROM logs.workersLogs
    WHERE accountTag = 'ACCOUNT_ID'
      AND scriptName = 'WORKER_NAME'
      AND attributes['event'] = 'alert.sending'
    ```

1. Set it to fire when the value is `>= 1`, as an **Average** over `1m`, and to **Run every** `1m`. Name it, such as `Field Notes: SES can't send email`, add your email address as its destination, and select **Create**.

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

1. Set it to fire when the value is `< 0.5`, as an **Average** over `15m`, and to **Run every** `1m`. Name it, such as `Field Notes: Kestrel has stopped`, add your email address, and select **Create**.

This Monitor can't be tested without stopping the app. In testing, with the schedule slowed to once an hour, it emailed about 13 minutes after the last tick, and resolved about 12 minutes after ticks resumed.

## 3. Send a test alert

Cloudflare's own **Test** button sends sample data, so this is the only way to prove the real path from the app's log to your inbox.

1. In the editor, open **Settings → Notifications**, and select **Send a test alert**. Kestrel writes the line the SES alert watches for, with `cause` set to `test`, and changes nothing else.

1. Wait for the alert email. In testing, it arrived about five and a half minutes after the line, from `noreply@notify.cloudflare.com`, with the subject `[Alert] Custom Alert '<name>' triggered`. A `[Resolved]` email followed about three minutes later, once no new line had arrived. Gmail filed both under **Updates**, so look there if your inbox shows nothing.

## What the alert emails mean

The two `[Resolved]` emails mean different things:

- For `SES can't send email`, Resolved means no new line was written, not that the problem is fixed. Kestrel writes the line once, when a problem begins, and not again while it lasts, so the Monitor resolves a few minutes after it whether or not anything changed, and you get no reminder. A new line, and a new alert, comes only when a different problem begins, or the same one again after email got out in between. To see whether the problem has cleared, open the dashboard: a refusal of the account shows as the red line at the top saying email isn't going out, and a spent quota as a red line naming the held send, which links to its page. Each line goes away once its problem has cleared.
- For `Kestrel has stopped`, Resolved means the once-a-minute ticks have resumed.

Each line the SES alert counts carries a `cause`, which says why email can't get out. Today the causes are:

- the reason SES gave for refusing the account, such as `credentials`, `configuration`, `sender`, or `suspended`
- `quota`, for a send held because the daily sending quota is spent
- `test`, from **Send a test alert**

A later release can add a cause, and the Monitor alerts on it with no change, since its query counts every `alert.sending` line. Filter on `event` equal to `alert.sending` in the Worker's **Observability** tab to read the causes, as in [Read the logs](07-verify.md#7-read-the-logs). Count over minutes, never a day: over long ranges the log's counts are estimated from a sample.

## Limits

Know these before you rely on the Monitors:

- The SQL API and Monitors are in beta, so their screens and fields can change.
- On the Workers Free plan, Cloudflare stops keeping logs for the rest of the day once the daily allowance is used, until it resets at 00:00 UTC. Until December 1, 2026, that allowance is 200,000 log events a day; from then, it is 0.5 GB a day, shared with traces. Either way it covers the whole Cloudflare account, not this Worker alone, and [Cloudflare's pricing page](https://developers.cloudflare.com/observability/pricing/) has the current terms. With no logs coming in, `Kestrel has stopped` fires falsely until the reset. An idle instance writes about 3,000 log events a day, far under either limit by Cloudflare's published average event size, so this is rare.
- An outage at Cloudflare can silence both the logs and the alerts.
- Kestrel can't see this setup, so the dashboard can't tell you whether the Monitors exist.
- A destination address outside your Cloudflare account may have to be verified first. This hasn't been tested.

When the test alert reaches your inbox, your instance can tell you about the two problems its own emails can't.

Next, [go live](09-go-live.md).
