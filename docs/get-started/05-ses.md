# Connect Amazon SES

This page connects the app to Amazon Simple Email Service (Amazon SES), which delivers the newsletter's email. A new SES account starts in a sandbox, where it can send only to addresses you've verified, until AWS reviews it. See [Request production access](06-production-access.md) to take it out of the sandbox.

In this guide, you set up how the app sends mail through SES and receives bounces and complaints, and how readers' replies reach the publisher.

## Before you begin

- An AWS account for the newsletter, from [Create an AWS account](04-aws-account.md).
- The publisher's inbox, for readers' replies.

## 1. Verify your sending hostname

SES sends only from an identity you've verified. Verifying the whole hostname lets any address on it send, and sets up DKIM, which lets inboxes trust your mail.

The same form sets a custom MAIL FROM domain, so SPF also passes for your domain. [SPF: authorize the return path](../reference/02-sending-domain-dns.md#spf-authorize-the-return-path) explains why it matters.

1. Open the [SES console](https://console.aws.amazon.com/ses/), and choose a region near you in the region menu at the top right.

    SES keeps identities, quotas, and the sandbox separately in each region, so do every step on this page in the region you chose. [Configuration](../reference/01-configuration.md#vars) says more about choosing one, under `AWS_REGION`.

1. Note the region's code, such as `us-west-2`. The menu shows it beside the region's name, and [Amazon SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) lists each one too. AWS names a region in more than one way, such as United States (Oregon) and US West (Oregon), so go by the code. Later steps use it.

1. Under **Configuration**, choose **Identities**, then **Create identity**.

1. Select **Domain**, and enter `send.example.com`. Leave **Assign a default configuration set** and **Assign to a tenant** unchecked. Section 4 makes the configuration set, and makes it the default then.

1. Select **Use a custom MAIL FROM domain**. In **MAIL FROM domain**, enter `bounce`; the form shows `.send.example.com` after it. For **Behavior on MX failure**, keep **Use default MAIL FROM domain**.

1. Expand **Advanced DKIM settings**, and select **Easy DKIM**. Keep **RSA_2048_BIT** as the key length. Choose **Create identity**.

1. The identity opens on its **Authentication** tab, which lists five DNS records to publish. Under DKIM, three CNAME records. Under **Custom MAIL FROM domain**, expand **Publish DNS records** for an MX record and a TXT record.

1. Add all five to your domain's DNS records in Cloudflare, with their proxy status set to **DNS only**. SES can't read a proxied record, so check each one's status. You can import them in one go, or add them by hand:

    - **Import them.** Copy this into a text file. Replace each `REPLACE_WITH_NAME_…` and `REPLACE_WITH_VALUE_…` with a DKIM record's name and value, exactly as SES lists them, and keep the dot after each. Replace `us-east-1` with your region's code. In the Cloudflare dashboard, open your domain's **DNS → Records**, select **Import and Export**, and import the file with **Proxy imported DNS records** unchecked. SES's own **Download .csv record set** is in a format Cloudflare doesn't import.

        ```
        REPLACE_WITH_NAME_1. 3600 IN CNAME REPLACE_WITH_VALUE_1.
        REPLACE_WITH_NAME_2. 3600 IN CNAME REPLACE_WITH_VALUE_2.
        REPLACE_WITH_NAME_3. 3600 IN CNAME REPLACE_WITH_VALUE_3.
        bounce.send.example.com. 3600 IN MX 10 feedback-smtp.us-east-1.amazonses.com.
        bounce.send.example.com. 3600 IN TXT "v=spf1 include:amazonses.com ~all"
        ```

    - **Add them by hand.** Add each record exactly as SES lists it. Cloudflare adds your domain to the name, so each DKIM name ends in `._domainkey.send`, and the MAIL FROM records are named `bounce.send`.

1. Wait until SES shows **Identity status** as **Verified**, and both **DKIM configuration** and **MAIL FROM configuration** as **Successful**.

## 2. Add a DMARC record

DMARC tells inboxes what to do with mail that fails its checks, and sends you reports about it. SES doesn't add this record, so you add it yourself. It starts in monitor mode, which reports without blocking anything.

1. In the Cloudflare dashboard, open your domain's DNS records, and add a record:

    - **Type:** `TXT`
    - **Name:** `_dmarc.send`
    - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com`

1. Replace `dmarc@example.com` with an address on your own domain that receives mail, such as one forwarded to your inbox with Cloudflare Email Routing. Reports arrive there as attachments. An address on another domain, such as a Gmail address, gets no reports unless that domain publishes a record allowing them, which Gmail doesn't.

1. Check that the record is published. This prints it:

    ```bash
    dig +short TXT _dmarc.send.example.com
    ```

[Sending-domain DNS](../reference/02-sending-domain-dns.md#dmarc-publish-a-policy-and-collect-reports) explains each record, and when to tighten DMARC.

## 3. Verify your test addresses

A new SES account starts in the sandbox: it sends only to addresses you've verified, up to 200 emails a day and one a second. The test emails in [Verify it works](07-verify.md) go to two addresses of your own, so verify those now. [Request production access](06-production-access.md) lifts the limit, once AWS grants it.

1. Choose two addresses you own, such as a personal address and a work address. Verify it works uses both.

1. For each, under **Identities**, choose **Create identity**, select **Email address**, and enter it. Leave **Assign a default configuration set** and **Assign to a tenant** unchecked. The form's notice about DMARC is about sending from the address, and the app only sends to it. Choose **Create identity**.

1. Open the email AWS sends to each address, and follow its link. The identity's status changes to **Verified**.

    AWS's email and confirmation page say you can now send from the address. That's expected: SES has one kind of verified address, and the same verification lets the sandbox send to it.

## 4. Send bounces and complaints to the app

SES reports bounces and complaints through Amazon Simple Notification Service (SNS), which delivers them to the app. The app then stops mailing an address that bounced or complained. A configuration set says which events SES reports, and an SNS topic carries them.

1. In SES, under **Configuration**, choose **Configuration sets**, then **Create set**. Name it `kestrel-mail`, keep every other option as it is, and choose **Create set**.

1. On the set's **Event destinations** tab, choose **Add destination**. Select **Hard bounces**, **Complaints**, **Deliveries**, and **Rendering failures**, and choose **Next**. The app logs a rendering failure, an email SES couldn't build, as an error.

    Leave the other six off, since the app already knows about them or doesn't act on them. **Sends** repeats what the send records, and **Delivery delays** end as a bounce or a delivery. **Rejects** (a virus) and **Subscriptions** (SES's own unsubscribe) don't arise, since the app's emails carry no attachments and their own unsubscribe link. **Opens** and **Clicks** would add tracking the app doesn't record.

1. For **Destination type**, select **Amazon SNS**. Name it `kestrel-sns`, and keep **Event publishing** enabled.

1. On the same screen, under **SNS topic**, choose **Create SNS topic**. Name it `kestrel-events`, leave the display name empty, and choose **Create topic**. Then select `kestrel-events` in the topic menu, if it isn't already. Choose **Next**, then **Add destination**.

1. Make the set your hostname's default, so SES reports on every email sent from it. Under **Identities**, open `send.example.com`, and choose its **Configuration set** tab, below the summary. Edit the **Default configuration set**, select **Assign a default configuration set**, select `kestrel-mail`, and save.

1. Open the topic in the [SNS console](https://console.aws.amazon.com/sns/), in the same region, and find its ARN. It looks like `arn:aws:sns:us-east-1:111122223333:kestrel-events`, where `us-east-1` is your region's code and `111122223333` is your account ID.

1. Check that SES may publish to the topic, on its **Access policy** tab. A topic created from SES's **Add destination**, as above, already lets SES publish to it from your account. Leave that statement as it is. For a topic you made in the SNS console instead, choose **Edit**, expand **Access policy**, and add this statement to the `Statement` list:

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

## 5. Create the app's AWS key

The app sends through an AWS Identity and Access Management (IAM) user whose key can only send email and read the account's sending status. That limits the harm if the key ever leaks. Reading the status lets the app show whether SES is still in the sandbox, take its send rate from the account, and warn when bounces and complaints can't reach it.

If `kestrel-sender` already exists, from an earlier release, don't create a second user or key. Update its policy instead, as the end of this section shows.

1. In the [IAM console](https://console.aws.amazon.com/iam/), choose **Policies**, then **Create policy**.

1. Choose the **JSON** editor, and replace its contents with this policy:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "ses:SendEmail",
            "ses:SendBulkEmail",
            "ses:SendTemplatedEmail",
            "ses:SendBulkTemplatedEmail",
            "ses:GetAccount",
            "ses:GetEmailIdentity"
          ],
          "Resource": "*"
        }
      ]
    }
    ```

1. Choose **Next**, name the policy `kestrel-send-email`, and choose **Create policy**. The review lists Pinpoint Email, SES, and SES v2, which is how IAM shows these SES actions.

1. Choose **IAM users**, then **Create user**. Name it `kestrel-sender`, leave console access off, and choose **Next**.

1. Choose **Attach policies directly**, search for `kestrel-send-email`, and select it. AWS recommends groups, which help manage many people, and one app's user doesn't need one. Choose **Next**, then **Create user**.

1. Open `kestrel-sender`, and choose **Create access key**. It's an access key, not an API key. For the use case, choose **Application running outside AWS**, and choose **Next**.

    AWS suggests IAM Roles Anywhere instead. It needs a certificate authority of your own, so use the access key.

1. For the description tag, enter the app's hostname, such as `newsletter.example.com`, so you can tell its key apart later. Choose **Create access key**.

1. Keep the page open: AWS shows the secret access key only once. Store the access key ID in the app, and paste it at the prompt:

    ```bash
    npx wrangler secret put AWS_ACCESS_KEY_ID --env production
    ```

1. Store the secret access key:

    ```bash
    npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
    ```

To update an existing key's policy, open **Policies** in the IAM console, then `kestrel-send-email`, and choose **Edit**. In the JSON editor, make its `Action` list match the policy above, and save. Without `ses:SendTemplatedEmail`, SES refuses even a test email. Once the key may call `ses:GetAccount`, the app's next check, within an hour, reads the account.

## 6. Connect the app and deploy

Until now the app has run with no email provider connected, refusing to send. Setting `PROVIDER` to `ses` connects SES, with the secrets you stored in sections 4 and 5. If a required one is missing, the app refuses to run until you store it, and `/health` names it.

1. In `wrangler.jsonc`, edit the `production` block's `vars`. Change `PROVIDER` to `ses` (it's `""` on a new instance; add it if your block has none). Change `AWS_REGION` to your region's code from section 1. Your other values stay as they are. The block ends up like this:

    ```jsonc
    "vars": {
      "PROVIDER": "ses",             // ← set to ses
      "APP_ORIGIN": "https://newsletter.example.com",
      "ARCHIVE_BASE_PATH": "/archive",
      "SENDING_DOMAIN": "send.example.com",
      "FROM_ADDRESS": "Newsletter <newsletter@send.example.com>",
      "AWS_REGION": "us-east-1"      // ← change: your region's code
    }
    ```

    On Workers Paid, also add `"SUBREQUEST_BUDGET": "10000"`, the plan's limit, so each minute sends more. Leave it out on Workers Free. [As your list grows](../guides/09-as-your-list-grows.md) says when Workers Paid is worth it: for faster sends at any size, and for the daily database writes of a list past about 1,000 subscribers.

    The app reads its send rate from your SES account, so there's nothing to change when AWS grants production access. **Settings → Email sender** shows the rate and where it comes from.

1. Commit the change, and push it:

    ```bash
    git commit -am "Send through Amazon SES"
    git push
    ```

1. Deploy:

    ```bash
    npx wrangler deploy --env production
    ```

1. Check that the app answers on your hostname:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

    Any other answer names the setting the app is missing.

1. In the editor, **Settings → Email sender** shows Amazon SES and your From address, where it said **No email provider connected** before. Within a couple of minutes, a **Sandbox** pill appears beside it, once the app has read your SES account.

1. In a browser, `https://newsletter.example.com/subscribe` shows the subscribe form, where it said signups aren't open yet.

## 7. Subscribe the app to the topic

SNS delivers events only to a subscriber that has confirmed. The app confirms on its own, once it checks that the request came from your topic.

1. Check that the app's webhook is public. It refuses a request that isn't from SNS:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" -X POST https://newsletter.example.com/webhooks/ses
    ```

    ```
    400
    ```

    Any other answer, such as a redirect to your Cloudflare login, means Access covers the webhook. Remove that path from your Access application.

1. In the SNS console, open your topic, and choose **Create subscription**. Check that **Topic ARN** shows the `kestrel-events` topic, and choose it if it's empty.

1. Set **Protocol** to **HTTPS**, and enter the endpoint:

    ```
    https://newsletter.example.com/webhooks/ses
    ```

1. Leave raw message delivery off.

1. Give SNS longer to retry. By default it retries a failed delivery 3 times over about a minute, then discards the event, so a bounce that arrives mid-deploy is lost. Expand **Delivery policy (HTTP/S)**, turn off **Use the default delivery policy**, and set these values:

    | Field | Value |
    | --- | --- |
    | Number of retries | `13` |
    | Retries without delay | `0` |
    | Minimum delay | `20` |
    | Minimum delay retries | `2` |
    | Maximum delay | `300` |
    | Maximum delay retries | `6` |
    | Retry-backoff function | Exponential |

    SNS then keeps trying for about 40 minutes. It allows an hour at most. The topic has a delivery policy of its own, under **Edit**. Setting it there instead also covers any subscription you add later.

1. Choose **Create subscription**.

1. Reload the subscription. Its status changes to **Confirmed**, with nothing for you to click.

    If it stays **Pending confirmation**, check that your Access application covers only `/dashboard` and `/api`. Check that `SNS_TOPIC_ARN` matches the topic's ARN, and that section 6's deploy finished. A mismatched ARN shows in the app's logs as a `webhook.refused` error naming both. Then request confirmation again from the topic's subscriptions. SNS doesn't let you delete a pending subscription, and removes it on its own after 48 hours.

1. **(Optional)** Keep what SNS still can't deliver. On the subscription, choose **Edit**, and set a **Redrive policy (dead-letter queue)** to an SQS queue of your own. SNS then moves an event there instead of discarding it. [Amazon SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html) covers the queue and its permissions.

## 8. Receive replies at your From address

Replies to a post go to your From address, `newsletter@send.example.com`, which has no inbox yet, so they bounce. The reader is told your domain couldn't be found. This section forwards that address to the publisher's inbox with Cloudflare Email Routing. Forwarding only receives mail, so it doesn't change how SES sends.

1. Check that your From address has no inbox yet. This prints nothing:

    ```bash
    dig +short MX send.example.com
    ```

    If it lists mail servers, `send.example.com` already receives mail elsewhere, and Email Routing would replace those servers. Check that your mail host has a mailbox for `newsletter@send.example.com`, and skip the rest of this section.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Compute → Email Service → Email Routing**.

1. Add `send.example.com` to Email Routing: select `example.com`, then **Settings**, and add `send` under **Subdomains**.

1. Cloudflare adds MX, SPF, and DKIM records for `send.example.com`, and locks them. Wait until they show as added. Its SPF record is for forwarding: SES's mail passes SPF at `bounce.send.example.com`, from section 1.

1. Under **Destination Addresses**, add the publisher's inbox. Open the email Cloudflare sends to it, and select **Verify email address**. If it isn't your inbox, ask the publisher to do this step.

1. Under **Routing Rules**, select **Create routing rule**. For **Email pattern**, enter `newsletter`, the part of your From address before the `@`, and select `send.example.com`. Set **Action** to **Send to an email**, select the publisher's inbox as the **Destination**, and save.

1. **(Optional)** Give your DMARC reports an inbox too. If the address in your DMARC record doesn't receive mail, add a rule that forwards `dmarc` the same way. Then change the record's `rua` to `mailto:dmarc@send.example.com`.

1. Check that your From address receives mail. This now lists Cloudflare's three `route` mail servers:

    ```bash
    dig +short MX send.example.com
    ```

1. Send an email to `newsletter@send.example.com` from an address whose mail doesn't go through the publisher's inbox. Gmail, for one, hides a forwarded copy of mail you sent yourself. In Email Routing's **Activity log**, the email shows as **Forwarded**.

    If it bounces saying the domain couldn't be found, the sender's provider is still remembering that `send.example.com` had no mail servers. That happens after an email to it before this section, and lasts up to 30 minutes on Cloudflare's DNS. Wait, and send it again.

Out-of-office and other automatic replies reach the publisher's inbox too. Bounces don't: they go to SES, which reports them to the app. The publisher answers from their own inbox, not from `newsletter@send.example.com`. To answer from the newsletter's address instead, give it a mailbox at a mail host such as [Fastmail](https://www.fastmail.help/hc/en-us/articles/360060591133) or [Google Workspace](https://support.google.com/a/answer/140034), in place of forwarding.

SES is now connected in the sandbox. Until AWS grants production access, it sends only to the addresses you verified in section 3. It also sends to the SES test addresses Verify it works uses. SES charges for each email it sends, test emails included, as [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) lists.

Next, [request production access](06-production-access.md).
