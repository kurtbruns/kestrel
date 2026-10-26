# Connect Amazon SES

This page connects the app to Amazon Simple Email Service (Amazon SES), which delivers the newsletter's email. A new SES account starts in a sandbox, where it can send only to addresses you've verified, until AWS reviews it. This page requests that review early, so you can test in the sandbox while you wait.

In this guide, you verify your sending hostname, set a custom MAIL FROM domain, add a DMARC record, and request production access. You then route bounces and complaints to the app, give it an AWS key, and deploy it with SES connected. Last, you forward readers' replies to the publisher's inbox.

## Before you begin

- An [AWS account](https://portal.aws.amazon.com/billing/signup), if you haven't created one already.
- The publisher's inbox, for readers' replies.

## 1. Verify your sending hostname

SES sends only from an identity you've verified. Verifying the whole hostname lets any address on it send, and sets up DKIM, which lets inboxes trust your mail.

1. Open the [SES console](https://console.aws.amazon.com/ses/), and choose a region near you in the menu at the top right. SES keeps identities, quotas, and the sandbox separately in each region, so do every step on this page in this one. A few newer regions must be [enabled for your account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-regions.html) first.

1. Note the region's code, such as `eu-west-1`. The menu shows only its name, such as Europe (Ireland), and [Amazon SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) lists each code beside its name. Later steps use this code.

1. Under **Configuration**, choose **Identities**, then **Create identity**.

1. Select **Domain**, and enter `send.example.com`. Keep the default DKIM settings, **Easy DKIM** with a 2048-bit key, and choose **Create identity**.

1. On the identity's **Authentication** tab, expand **Publish DNS records**. It lists three CNAME records.

1. In the Cloudflare dashboard, add each record to your domain's DNS records, exactly as SES lists it, with its proxy status set to **DNS only**. Cloudflare adds your domain to the name, so each name ends in `._domainkey.send`.

1. Wait until SES shows **DKIM configuration** as **Successful** and **Identity status** as **Verified**.

## 2. Set a custom MAIL FROM domain

By default, SES sends with its own return path, so Gmail shows your mail as "mailed-by `amazonses.com`", and only DKIM ties it to your domain. A custom MAIL FROM domain puts your hostname there too, so SPF also passes for your domain. Your mail then still passes DMARC, the check section 3 sets up, if DKIM ever fails. It also meets Gmail's bulk-sender rule to set up SPF for your domain.

1. In SES, open the `send.example.com` identity. Under **Custom MAIL FROM domain**, choose **Edit**.

1. Select **Use a custom MAIL FROM domain**, and enter `bounce.send.example.com`. For **Behavior on MX failure**, keep **Use default MAIL FROM domain**. Choose **Save changes**.

1. In Cloudflare, add the two records SES lists, with your region's code in place of `us-east-1`:

    - **Type:** `MX`, **Name:** `bounce.send`, **Mail server:** `feedback-smtp.us-east-1.amazonses.com`, **Priority:** `10`
    - **Type:** `TXT`, **Name:** `bounce.send`, **Content:** `v=spf1 include:amazonses.com ~all`

1. Wait until SES shows the MAIL FROM domain's status as successful.

## 3. Add a DMARC record

DMARC tells inboxes what to do with mail that fails its checks, and sends you reports about it. SES doesn't add this record, so you add it yourself. It starts in monitor mode, which reports without blocking anything.

1. In the Cloudflare dashboard, open your domain's DNS records, and add a record:

    - **Type:** `TXT`
    - **Name:** `_dmarc.send`
    - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com`

1. Replace `dmarc@example.com` with an address that receives mail. Reports arrive there as attachments.

[Sending-domain DNS](../reference/02-sending-domain-dns.md#dmarc-publish-a-policy-and-collect-reports) explains each record, and when to tighten DMARC.

## 4. Request production access

A new SES account starts in the sandbox: it sends only to addresses you've verified, up to 200 emails a day and one a second. Ask AWS to lift those limits now, and test while you wait.

1. Name the publication, since AWS may visit its website to review the request. In the editor, open **Settings → Publication identity**, and enter the name and tagline, or ask the publisher for them.

1. In SES, open the **Account dashboard**, select **View Get set up page**, and then **Request production access**.

1. Fill in the request:

    - **Mail type:** Marketing
    - **Website URL:** `https://newsletter.example.com/`

    Leave the other fields as they are.

1. Check the acknowledgement, and select **Submit request**. AWS Support answers by email, and may ask how you collect addresses and handle bounces.

1. Verify two addresses you own, such as a personal address and a work address, so the sandbox lets you mail them. Your test emails go to these. For each, under **Identities**, choose **Create identity**, select **Email address**, and follow the link in the email AWS sends.

If AWS asks for more detail, or denies the request, reply in the support case, or open a new request from the **Account dashboard**. Say how Kestrel handles the list:

- Signups use double opt-in: each subscriber confirms by email before joining the list.
- Every post offers one-click unsubscribe.
- Bounces and complaints reach the app, and it stops mailing those addresses automatically.
- How many subscribers the newsletter expects, and how often it sends.

In the meantime, continue with the rest of this guide.

## 5. Send bounces and complaints to the app

SES reports bounces and complaints through Amazon Simple Notification Service (SNS), which delivers them to the app. The app then stops mailing an address that bounced or complained. A configuration set says which events SES reports, and an SNS topic carries them.

1. In SES, under **Configuration**, choose **Configuration sets**, then **Create set**. Name it `kestrel-mail`, and choose **Create set**.

1. On the set's **Event destinations** tab, choose **Add destination**. Select **Hard bounces**, **Complaints**, **Deliveries**, and **Rendering failures**, and choose **Next**. The app logs a rendering failure, an email SES couldn't build, as an error.

1. For **Destination type**, select **Amazon SNS**. Name it `kestrel-sns`, and keep **Event publishing** enabled. Choose **Next**.

1. For **SNS topic**, choose **Create SNS topic**. Make it a **Standard** topic named `kestrel-events`. Choose **Next**, then **Add destination**.

1. Make the set your hostname's default, so SES reports on every email sent from it. Open the `send.example.com` identity, and choose the **Configuration set** tab. Under **Default configuration set**, choose **Edit**, select `kestrel-mail`, and save.

1. Open the topic in the [SNS console](https://console.aws.amazon.com/sns/), and find its ARN. It looks like `arn:aws:sns:us-east-1:111122223333:kestrel-events`, where `us-east-1` is your region's code and `111122223333` is your account ID.

1. Let SES publish to the topic. Choose **Edit**, expand **Access policy**, and add this statement to the `Statement` list:

    ```json
    {
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "REPLACE_WITH_TOPIC_ARN",
      "Condition": {
        "StringEquals": {
          "AWS:SourceAccount": "REPLACE_WITH_ACCOUNT_ID",
          "AWS:SourceArn": "arn:aws:ses:us-east-1:REPLACE_WITH_ACCOUNT_ID:configuration-set/kestrel-mail"
        }
      }
    }
    ```

    Replace the topic ARN, both copies of the account ID, and `us-east-1` with the values from your ARN. Choose **Save changes**.

1. Store the topic's ARN in the app. In your instance's repository, run this, and paste the ARN at the prompt. The app accepts events only from this topic:

    ```bash
    npx wrangler secret put SNS_TOPIC_ARN --env production
    ```

1. Store the configuration set's name, `kestrel-mail`. It's optional but recommended: the app names the set on every email, so SES reports on each one even without the hostname's default. Type it exactly as the set is named in this region, since SES refuses every email that names a set it can't find:

    ```bash
    npx wrangler secret put SES_CONFIGURATION_SET --env production
    ```

## 6. Create the app's AWS key

The app sends through an AWS Identity and Access Management (IAM) user whose key can only send email. That limits the harm if the key ever leaks.

1. In the [IAM console](https://console.aws.amazon.com/iam/), go to **Users**, and choose **Create user**. Name it `kestrel-sender`, and leave console access off.

1. When asked for permissions, choose **Attach policies directly**, then **Create policy**. The policy editor opens in a new browser tab.

1. In the new tab, choose the **JSON** editor, and replace its contents with this policy:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": ["ses:SendEmail", "ses:SendBulkEmail"],
          "Resource": "*"
        }
      ]
    }
    ```

    Choose **Next**, name the policy `kestrel-send-email`, and choose **Create policy**. You can close this tab.

1. Go back to the first tab, where you're creating the user. Refresh the policy list, search for `kestrel-send-email`, and select it.

1. Choose **Next**, then **Create user**.

1. Open the user, and on the **Security credentials** tab, choose **Create access key**. For the use case, choose **Application running outside AWS**.

1. Keep the page open: AWS shows the secret access key only once. Store the access key ID in the app, and paste it at the prompt:

    ```bash
    npx wrangler secret put AWS_ACCESS_KEY_ID --env production
    ```

1. Store the secret access key:

    ```bash
    npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
    ```

## 7. Set the provider and deploy

Until now the app has run with no email provider connected, refusing to send. Setting `PROVIDER` to `ses` connects SES, with the secrets you stored in sections 5 and 6. If a required one is missing, the app refuses to run until you store it, and `/health` names it.

1. In `wrangler.jsonc`, edit the `production` block's `vars`. Change `PROVIDER` to `ses` (it's `""` on a new instance; add it if your block has none), and add `SES_MAX_SEND_RATE`. Change `AWS_REGION` to your region's code from section 1. Your other values stay as they are. The block ends up like this:

    ```jsonc
    "vars": {
      "PROVIDER": "ses",             // ← set to ses
      "APP_ORIGIN": "https://newsletter.example.com",
      "ARCHIVE_BASE_PATH": "/archive",
      "SENDING_DOMAIN": "send.example.com",
      "FROM_ADDRESS": "Newsletter <newsletter@send.example.com>",
      "AWS_REGION": "us-east-1",     // ← change: your region's code
      "SES_MAX_SEND_RATE": "1"       // ← new: your maximum send rate; 1 in the sandbox
    }
    ```

    On Workers Paid, also add `"SUBREQUEST_BUDGET": "10000"`, the plan's limit, so each minute sends more. Leave it out on Workers Free, which suits a list of up to about 1,000 subscribers. [As your list grows](../guides/09-as-your-list-grows.md) says why.

    When AWS grants production access, set `SES_MAX_SEND_RATE` to the maximum send rate on the **Account dashboard**, and deploy again. The app keeps to that rate, so SES doesn't throttle your send.

1. Commit the change, and push it:

    ```bash
    git commit -am "Send through Amazon SES"
    git push
    ```

1. Deploy:

    ```bash
    npx wrangler deploy --env production
    ```

## 8. Subscribe the app to the topic

SNS delivers events only to a subscriber that has confirmed. The app confirms on its own, once it checks that the request came from your topic.

1. In the SNS console, open your topic, and choose **Create subscription**.

1. Set **Protocol** to **HTTPS**, and enter the endpoint:

    ```
    https://newsletter.example.com/webhooks/ses
    ```

1. Leave raw message delivery off, and choose **Create subscription**.

1. Reload the subscription. Its status changes to **Confirmed**, with nothing for you to click.

    If it stays **Pending confirmation**, check that your Access application covers only `/dashboard` and `/api`, that `SNS_TOPIC_ARN` matches the topic's ARN, and that section 7's deploy finished. A mismatched ARN shows in the app's logs as a `webhook.refused` error naming both. Then request confirmation again from the topic's subscriptions. SNS doesn't let you delete a pending subscription, and removes it on its own after 48 hours.

1. Give SNS longer to retry. By default it retries a failed delivery 3 times over about a minute, then discards the event, so a bounce that arrives mid-deploy is lost. Open the topic, choose **Edit**, and expand **Delivery retry policy (HTTP/S)**. Turn off the default policy, set these values, and choose **Save changes**:

    | Field | Value |
    | --- | --- |
    | Number of retries | `13` |
    | Retries without delay | `0` |
    | Minimum delay | `20` |
    | Minimum delay retries | `2` |
    | Maximum delay | `300` |
    | Maximum delay retries | `6` |
    | Retry-backoff function | Exponential |

    SNS then keeps trying for about 40 minutes. It allows an hour at most.

1. **(Optional)** Keep what SNS still can't deliver. On the subscription, choose **Edit**, and set a **Redrive policy (dead-letter queue)** to an SQS queue of your own. SNS then moves an event there instead of discarding it. [Amazon SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html) covers the queue and its permissions.

## 9. Receive replies at your From address

Replies to a post go to your From address, `newsletter@send.example.com`, which has no inbox yet, so they bounce. This section forwards that address to the publisher's inbox with Cloudflare Email Routing. Forwarding only receives mail, so it doesn't change how SES sends.

1. Check that your From address has no inbox yet. This prints nothing:

    ```bash
    dig +short MX send.example.com
    ```

    If it lists mail servers, `send.example.com` already receives mail elsewhere, and Email Routing would replace those servers. Check that your mail host has a mailbox for `newsletter@send.example.com`, and skip to [Check it](#check-it).

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Compute → Email Service → Email Routing**.

1. Add `send.example.com` to Email Routing: select `example.com`, then **Settings**, and add `send` under **Subdomains**.

1. Cloudflare adds MX, SPF, and DKIM records for `send.example.com`, and locks them. Wait until they show as added.

1. Under **Destination Addresses**, add the publisher's inbox. Open the email Cloudflare sends to it, and select **Verify email address**. If it isn't your inbox, ask the publisher to do this step.

1. Under **Routing Rules**, select **Create routing rule**. For **Email pattern**, enter `newsletter`, the part of your From address before the `@`, and select `send.example.com`. Set **Action** to **Send to an email**, select the publisher's inbox as the **Destination**, and save.

1. **(Optional)** Give your DMARC reports an inbox too. If the address in your DMARC record doesn't receive mail, add a rule that forwards `dmarc` the same way. Then change the record's `rua` to `mailto:dmarc@send.example.com`.

Out-of-office and other automatic replies reach the publisher's inbox too. Bounces don't: they go to SES, which reports them to the app. The publisher answers from their own inbox, not from `newsletter@send.example.com`. To answer from the newsletter's address instead, give it a mailbox at a mail host such as [Fastmail](https://www.fastmail.help/hc/en-us/articles/360060591133) or [Google Workspace](https://support.google.com/a/answer/140034), in place of forwarding.

## Check it

1. The app answers on your hostname:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

1. The webhook is public, and refuses a request that isn't from SNS:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" -X POST https://newsletter.example.com/webhooks/ses
    ```

    ```
    400
    ```

    Any other answer, such as a redirect to your Cloudflare login, means Access covers the webhook. Remove that path from your Access application.

1. The SNS subscription shows **Confirmed**.

1. Your From address receives mail. This lists Cloudflare's three `route` mail servers, or your own mail host's if you skipped section 9's forwarding:

    ```bash
    dig +short MX send.example.com
    ```

1. In the editor, **Settings → Email sender** shows Amazon SES and your From address, where it said **No email provider connected** before.

1. In a browser, `https://newsletter.example.com/subscribe` shows the subscribe form, where it said signups aren't open yet.

The test emails in the next step prove the rest, including a reply. In the sandbox, they go only to the addresses you verified in section 4, and to the SES test addresses that page lists. SES charges for each email it sends, test emails included, as [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) lists.

Next, [verify it works](05-verify.md).
