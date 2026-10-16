# As your list grows

A new instance runs on Cloudflare's free Workers plan with your starting Amazon SES limits. Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. Two limits matter as the list grows: how fast SES lets you send, and how many database writes the free plan allows a day.

In this guide, you raise your SES limits, which helps on either plan, and upgrade to Workers Paid, which a larger list needs. Then you see how long a send takes after each.

## 1. Raise your SES limits

SES caps how many emails your account sends a day, and how many a second. A send that hits the daily quota waits, emails you, and resumes on its own once the quota frees up. Raising your maximum send rate to 50 a second costs nothing, and it makes every send faster.

1. Ask AWS for a higher daily quota and a maximum send rate of 50, as AWS's [Increasing your Amazon SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas-request-increase.html) describes.

1. When AWS grants it, the SES **Account dashboard** shows your new rate. In `wrangler.jsonc`, set the `production` block's [`SES_MAX_SEND_RATE`](../reference/01-configuration.md#ses_max_send_rate) to match.

1. Commit the change, and push it:

    ```bash
    git commit -am "Match the SES send rate"
    git push
    ```

1. Deploy:

    ```bash
    npx wrangler deploy --env production
    ```

## 2. Upgrade to Workers Paid

On the free plan, [D1](https://developers.cloudflare.com/d1/platform/pricing/) allows 100,000 written rows a day, reset at midnight UTC. A send writes about 14 rows a recipient, receipts included, and an import about 7 for each new subscriber. Once the day's rows are spent, the whole app stops until midnight UTC, the SES webhook with it, so that day's bounces and complaints are lost and suppress no one.

It's recommended to upgrade from about 1,000 subscribers. Past that, the Dashboard and the Subscribers screen say so, and so does an import that would take the list past it. Past about 5,000, a send that could use up the day on its own also warns before it's scheduled. The app doesn't count the day's writes, so between the two, two large sends or several imports and a send on one UTC day can still use it up without a warning at that moment.

1. Upgrade your Cloudflare account to the $5 [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/), which has no daily limit on writes.

1. In `wrangler.jsonc`, add `"SUBREQUEST_BUDGET": "10000"` to the `production` block's `vars`. It tells the app it's on Workers Paid, so each minute sends far more ([`SUBREQUEST_BUDGET`](../reference/01-configuration.md#subrequest_budget)).

1. Commit the change, and push it:

    ```bash
    git commit -am "Run on Workers Paid"
    git push
    ```

1. Deploy:

    ```bash
    npx wrangler deploy --env production
    ```

Over years, one more limit can matter: on the free plan, one [D1 database](https://developers.cloudflare.com/d1/platform/limits/) holds at most 500 MB, and every send keeps a row for each recipient in its record. Workers Paid raises it to 10 GB.

## How long a send takes

| Setup | 1,000 subscribers | 5,000 subscribers | 10,000 subscribers |
| --- | --- | --- | --- |
| Free plan, a starting SES rate of 14 | about 18 minutes | about 1.5 hours | over the free plan's daily writes |
| Free plan, SES rate raised to 50 | about 5 minutes | about 25 minutes | over the free plan's daily writes |
| Workers Paid, SES rate of 14 | about 2 minutes | about 7 minutes | about 15 minutes |
| Workers Paid, SES rate of 50 | under a minute | about 2 minutes | about 4 minutes |

## Check it

1. The SES **Account dashboard** shows the maximum send rate you set in `SES_MAX_SEND_RATE`.

1. On Workers Paid, the import screen under **Subscribers → Import** reads "CSV or .txt, up to 10,000 rows."
