# Connect Amazon SES

Kestrel sends the newsletter's posts through Amazon SES, Amazon's email service. SES only delivers the mail: Kestrel keeps the list, each subscriber's consent, and the record of every send. AWS reviews your account before it lets you send to anyone but yourself. This page asks for that early, and you test in the sandbox while you wait.

In this guide, you verify your sending hostname with SES and add a DMARC record. You forward readers' replies to the publisher's inbox, and ask AWS for production access. You also route bounces and complaints to the app through SNS. Then you give the app its AWS credentials, set the provider, and deploy.

## Before you begin

- An [AWS account](https://portal.aws.amazon.com/billing/signup).

To move an instance that already sends through another provider or another SES account, read [Switch an instance that already sends](#switch-an-instance-that-already-sends) first.

## 1. Verify your sending hostname

SES sends only from an identity you've verified. Verifying the whole hostname, rather than one address, lets any address on it send. It also sets up DKIM, which lets inboxes trust your mail.

1. Open the [SES console](https://console.aws.amazon.com/ses/), and choose the region you send from in the menu at the top right. Any region that offers SES works, so pick one near you. A few newer regions must be [enabled for your account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-regions.html) before you can use them. SES keeps identities, quotas, and the sandbox separately in each region, so do every step in this one.

1. Note the region's code. The menu shows a name, such as Europe (Ireland), but later steps need its code, such as `eu-west-1`. [Amazon SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) lists each region's code beside its name. The MAIL FROM record, the SNS access policy, and `AWS_REGION` all use this one code.

1. Under **Configuration**, choose **Identities**, then **Create identity**.

1. Select **Domain**, and enter `send.example.com`. Keep the default DKIM settings: **Easy DKIM**, with a 2048-bit key. Choose **Create identity**.

1. On the identity's **Authentication** tab, expand **Publish DNS records**. It lists three CNAME records.

1. In the Cloudflare dashboard, add each record to your domain's DNS records, exactly as SES lists it. Set each one's proxy status to **DNS only**. Cloudflare adds your domain to the name, so a name ends in `._domainkey.send`.

1. Wait until SES shows **DKIM configuration** as **Successful** and **Identity status** as **Verified**.

## 2. Add a DMARC record

DMARC tells inboxes what to do with mail that fails its checks, and sends you reports about it. SES doesn't add this record, so you add it yourself. It starts in monitor mode, which reports without blocking anything.

1. In the Cloudflare dashboard, open your domain's DNS records, and add a record:

    - **Type:** `TXT`
    - **Name:** `_dmarc.send`
    - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com`

1. Replace `dmarc@example.com` with an address that receives mail. Reports arrive there as attachments.

[Sending-domain DNS](../reference/02-sending-domain-dns.md#dmarc-publish-a-policy-and-collect-reports) explains each record, and when to tighten DMARC.

## 3. Receive replies at your From address

When a reader replies to a post, or to their confirmation email, the reply goes to your From address, `newsletter@send.example.com`. Nothing receives mail there yet, so the reply bounces. Kestrel only sends mail, so you give the address an inbox yourself. Here you forward it to the publisher's inbox, with Cloudflare Email Routing, which is free on every plan. The publisher is whoever writes and sends the newsletter, which may be you.

`send.example.com` receives no other mail, so turning on Email Routing there changes nothing else. Your SES records sit on other names under it. Inboxes check SES's mail for SPF at its return path, not here, so sending is unaffected.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Compute → Email Service → Email Routing**.

1. Add `send.example.com` to Email Routing. Cloudflare adds subdomains from your domain's own settings: select `example.com`, then **Settings**, and add `send` under **Subdomains**.

1. Cloudflare adds MX, SPF, and DKIM records for `send.example.com`, and locks them. Wait until they show as added.

1. Under **Destination Addresses**, add the publisher's inbox. Open the email Cloudflare sends to it, and select **Verify email address**. If it isn't your inbox, ask the publisher to do this step. An address you've already verified with Cloudflare, such as one for [notifications](../guides/03-notifications.md), is listed already.

1. Under **Routing Rules**, select **Create routing rule**. For **Email pattern**, enter `newsletter`, the part of your From address before the `@`, and select `send.example.com`. Set **Action** to **Send to an email**, select the publisher's inbox as the **Destination**, and save.

On a subdomain, Email Routing forwards only the addresses you add a rule for, with no catch-all. That's all a From address needs.

- **Automatic replies arrive too.** Out-of-office and other automatic replies go to your From address, so they reach the publisher's inbox. Bounces don't: they go to SES's return path, and the app handles them as before.
- **Your DMARC reports need an inbox too.** Your DMARC record's report address may not receive mail. If so, change the record's `rua` to `mailto:dmarc@send.example.com`, and add a second rule that forwards `dmarc` the same way.
- **Answers come from the publisher's inbox.** A forwarded reply comes from the reader's own address. An answer to it goes out from the inbox it was forwarded to, not from `newsletter@send.example.com`.

To answer from the newsletter's own address, give it a real mailbox instead of forwarding it. Point `send.example.com`'s MX records at a mail host you use, such as [Fastmail](https://www.fastmail.help/hc/en-us/articles/360060591133) or [Google Workspace](https://support.google.com/a/answer/140034). Then create `newsletter@send.example.com` there, as the host's docs describe. If you send from it, the host's SPF and DKIM records go on `send.example.com` beside SES's. SES's mail is unaffected, since its SPF is checked at its return path. And if your From address is on a domain that already receives mail, replies already reach it, and you can skip this section.

Some replies ask the publisher to do something, and Kestrel can't see them, so the publisher acts on them, as [Sending rules](../publishing/02-sending-rules.md#when-a-reader-asks-to-leave-or-to-be-deleted) describes.

## 4. (Optional) Set a custom MAIL FROM domain

SES sends with its own return path by default, so SPF passes for `amazonses.com` rather than for your hostname. DMARC still passes, through DKIM. A custom MAIL FROM domain makes SPF pass for your hostname too, a second check in your favor.

1. In SES, open the `send.example.com` identity. Under **Custom MAIL FROM domain**, choose **Edit**.

1. Select **Use a custom MAIL FROM domain**, and enter `bounce.send.example.com`. For **Behavior on MX failure**, keep **Use default MAIL FROM domain**. Choose **Save changes**.

1. In Cloudflare, add the two records SES lists. Replace `us-east-1` with your region's code from section 1:

    - **Type:** `MX`, **Name:** `bounce.send`, **Mail server:** `feedback-smtp.us-east-1.amazonses.com`, **Priority:** `10`
    - **Type:** `TXT`, **Name:** `bounce.send`, **Content:** `v=spf1 include:amazonses.com ~all`

1. Wait until SES shows the MAIL FROM domain as **Successful**.

## 5. Request production access

A new SES account starts in the sandbox. It sends only to addresses you've verified in SES, up to 200 emails a day and one a second. Ask AWS to lift those limits now, and test while you wait.

1. Name the publication first, or ask the publisher for its name, since AWS may visit its website to review the request. In the editor, open **Settings → Publication identity**, and enter the name and tagline. Until then, the public pages show the name in your From address. The subscribe form stays closed until section 8 sets the provider.

1. In SES, open the **Account dashboard**, select **View Get set up page**, and then **Request production access**.

1. Fill in the request:

    - **Mail type:** Marketing
    - **Website URL:** `https://newsletter.example.com/`

1. Check the acknowledgement, and select **Submit request**. AWS Support answers by email, and may ask how you collect addresses and handle bounces.

1. While you wait, verify the two addresses you test with in [Verify it works](05-verify.md#before-you-begin), so the sandbox lets you mail them. For each, under **Identities**, choose **Create identity**, select **Email address**, and follow the link in the email AWS sends.

If AWS asks for more detail, reply in the support case. If it denies the request, reply there, or open a new request from the **Account dashboard**. Either way, say how Kestrel handles the list:

- Signups use double opt-in: each subscriber confirms by email before joining the list.
- Every post offers one-click unsubscribe.
- Bounces and complaints reach the app through SNS, and it stops mailing those addresses automatically.
- How many subscribers the newsletter expects, and how often it sends.

Your account stays in the sandbox until AWS grants access, so don't go live before then. In the sandbox, SES refuses mail to any address you haven't verified:

- A signup from an unverified address gets no confirmation email. The app emails the publisher about it, at most once a day.
- A post goes to your verified addresses and then waits, with the line "The provider is refusing the account" and SES's words. No reader is marked unsent. Once AWS grants access, the post goes to the rest at its next retry, mailing no one twice.
- A daily quota refusal in the sandbox (200 emails a day) means the same thing: request production access rather than a higher quota.

When AWS grants access, the **Account dashboard** shows your daily quota and your maximum send rate. You set the rate in the app in section 8. The rate decides how fast a send goes out, and [As your list grows](../guides/09-as-your-list-grows.md) says when to ask AWS to raise it.

## 6. Send bounces and complaints to SNS

SES reports what happens to each email through SNS, the AWS notification service. A configuration set says which events to report, and an SNS topic carries them to the app.

1. In SES, under **Configuration**, choose **Configuration sets**, then **Create set**. Name it `kestrel-mail`, and choose **Create set**.

1. On the set's **Event destinations** tab, choose **Add destination**. Select **Hard bounces**, **Complaints**, **Deliveries**, and **Rendering failures**, and choose **Next**. A rendering failure is an email SES took but couldn't build. It shouldn't happen, and the app logs it as an error if it does.

1. For **Destination type**, select **Amazon SNS**. Name it `kestrel-sns`, and keep **Event publishing** enabled. Choose **Next**.

1. For **SNS topic**, choose **Create SNS topic**. Make it a **Standard** topic named `kestrel-events`. Choose **Next**, then **Add destination**.

1. Make the set your hostname's default, so SES reports on every email sent from it. Open the `send.example.com` identity, and choose the **Configuration set** tab. Under **Default configuration set**, choose **Edit**, select `kestrel-mail`, and save.

1. Open the topic in the [SNS console](https://console.aws.amazon.com/sns/), and copy its ARN. It looks like `arn:aws:sns:us-east-1:111122223333:kestrel-events`. After `sns` comes your region's code, then your 12-digit account ID. The account menu at the top right of the console also shows the account ID.

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

    Replace the topic ARN, and both copies of the account ID, with the values from your ARN. Replace `us-east-1` with your region's code, the same one the ARN shows. Choose **Save changes**.

You subscribe the app to the topic in section 9, once it runs on SES.

## 7. Create the app's AWS key

The app sends through an IAM user whose key can only send email. That limits the harm if the key ever leaks.

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

1. Copy the access key ID and the secret access key. AWS shows the secret only once.

## 8. Set the provider and deploy

Until now the app has run with no email provider connected, refusing to send. Setting `PROVIDER` connects SES. Store the secrets before you set it. With `PROVIDER` set to `ses` and a required secret missing, the app refuses to run, and sends nothing, until you store it. `/health` and the editor's **A setting needs fixing** page name the missing secret, and reader pages say the newsletter is temporarily unavailable. `SES_CONFIGURATION_SET` is the one optional secret.

1. Store the access key ID, and paste it at the prompt:

    ```bash
    npx wrangler secret put AWS_ACCESS_KEY_ID --env production
    ```

1. Store the secret access key:

    ```bash
    npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
    ```

1. Store the topic ARN from section 6. The app accepts events only from this topic:

    ```bash
    npx wrangler secret put SNS_TOPIC_ARN --env production
    ```

1. Store the configuration set's name, `kestrel-mail`. It's optional but recommended: the app names it on every email, so SES reports on each one even without the default. Type it exactly as the set is named in this region: if SES can't find the set, it refuses every email, and a list send is held until the name is fixed or the set created:

    ```bash
    npx wrangler secret put SES_CONFIGURATION_SET --env production
    ```

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

## 9. Subscribe the app to the topic

SNS delivers events only to a subscriber that has confirmed. The app confirms on its own, once it checks that the request came from your topic.

1. In the SNS console, open your topic, and choose **Create subscription**.

1. Set **Protocol** to **HTTPS**, and enter the endpoint:

    ```
    https://newsletter.example.com/webhooks/ses
    ```

1. Leave raw message delivery off, and choose **Create subscription**.

1. Reload the subscription. Its status changes to **Confirmed**, with nothing for you to click.

1. Give SNS longer to retry. By default it retries a failed delivery 3 times over about a minute, then discards the event, so a bounce that arrives while the app is briefly down or mid-deploy is lost, and the address gets your next post. Open the topic, choose **Edit**, and expand **Delivery policy (HTTP/S)**. Clear **Use the default delivery policy**, set these, and choose **Save changes**:

    | Field | Value |
    | --- | --- |
    | Number of retries | `13` |
    | Retries without delay | `0` |
    | Minimum delay | `20` |
    | Minimum delay retries | `2` |
    | Maximum delay | `300` |
    | Maximum delay retries | `6` |
    | Retry-backoff function | Exponential |

    SNS then keeps trying for most of an hour, the longest it allows. It never retries an event the app refused. The app refuses only an event it can't verify came from your topic, and logs an error when one claims to be from SNS.

1. **(Optional)** Keep what SNS still can't deliver. On the subscription, choose **Edit**, and set a **Redrive policy (dead-letter queue)** to an SQS queue of your own. SNS then moves an event there instead of discarding it, where you can read it later. [Amazon SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html) covers the queue and its permissions.

If it stays **Pending confirmation**, the request never reached the app, or the app refused it. Check, in this order:

- **Access covers `/webhooks/ses`.** If your Access application covers more than `/dashboard` and `/api`, SNS gets the login page instead of the app. Remove that path from your Access application, so only `dashboard` and `api` remain.
- **`SNS_TOPIC_ARN` matches the topic's ARN.** If it doesn't, the app's logs show a `webhook.refused` error naming both.
- **The deploy in section 8 finished.**

Once you've fixed the cause, select the subscription, and choose **Request confirmation**. SNS sends the request again, and the app confirms it. SNS doesn't let you delete a subscription while it's pending, and removes it on its own after 48 hours.

## Switch an instance that already sends

Change `PROVIDER`, or move to another account with the same provider, only while no send is sending. The dashboard lists any send in progress.

When a request to a provider gets no answer, Kestrel can't know whether its recipients were mailed. Moving to SES, from another provider or another SES account, mails none of them twice. Kestrel never repeats an unanswered request to SES, so those recipients wait for you to decide whether they were mailed. Use **Resolve** on the send's page.

Kestrel can't tell whether those emails went out. SES's console shows sent messages only if you've turned on Virtual Deliverability Manager, which this guide doesn't set up. So **Assume not sent** is the safe default. Those readers may miss this post, but they get your next one. No one is mailed twice. Choose **Assume sent** only when you know otherwise, such as a reader who says they got it.

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

1. Your From address has somewhere to go. In Cloudflare, your domain's DNS records show the ones Email Routing added for `send`, beside section 1's DKIM records:

    - **Type:** `MX`, **Name:** `send`, three of them, for `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, and `route3.mx.cloudflare.net`
    - **Type:** `TXT`, **Name:** `send`, **Content:** `v=spf1 include:_spf.mx.cloudflare.net ~all`
    - **Type:** `TXT`, **Name:** `cf2024-1._domainkey.send`, Cloudflare's DKIM key

    The world sees the MX records too:

    ```bash
    dig +short MX send.example.com
    ```

    It lists the three `route` servers. Email Routing's **Routing Rules** shows your rule for `newsletter@send.example.com`, and **Destination Addresses** shows the publisher's inbox as verified. A reply to your test email in the next step proves the forwarding works.

1. In the editor, **Settings → Email sender** shows Amazon SES and your From address, where it said **No email provider connected** before.

1. In a browser, `https://newsletter.example.com/subscribe` shows the subscribe form, where it said signups aren't open yet.

The test sends in the next step prove the rest. In the sandbox, send them only to the addresses you verified in section 5, and to the SES test addresses that page lists.

SES charges for each email it sends, test emails included. [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) lists the rates.

Next, [verify it works](05-verify.md).
