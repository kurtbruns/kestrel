# Use Amazon SES instead of Resend

Amazon SES costs less than Resend for a large list, but takes more setup. AWS reviews your account before it lets you send to anyone but yourself. Kestrel also needs Cloudflare's Workers Paid plan to send through SES at a useful pace.

In this guide, you verify your sending hostname with SES, ask AWS for production access, and route bounces and complaints to the app through SNS. Then you give the app its AWS credentials, switch it to SES, and deploy. Follow it in place of [Connect Resend](../get-started/04-resend.md).

## Before you begin

You need:

- An [AWS account](https://portal.aws.amazon.com/billing/signup).
- Cloudflare's [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/).
- The app deployed and locked, from [Deploy the app](../get-started/02-deploy.md) and [Lock the dashboard with Access](../get-started/03-access.md).

To move an instance that already sends through Resend, read [Switch an instance that already sends](#switch-an-instance-that-already-sends) first.

## How fast SES sends

A send goes out a slice at a time, one slice a minute. Each slice stays inside the subrequests Cloudflare allows one run of the Worker, which [`SUBREQUEST_BUDGET`](../reference/01-configuration.md#vars) sets. Resend takes up to 100 recipients a request. SES takes one, so each recipient costs far more of that allowance.

- **Workers Free:** about 18 recipients a minute. A send to 1,000 subscribers takes about an hour, so use Resend on this plan.
- **Workers Paid, with `SUBREQUEST_BUDGET` set to `10000`:** up to about 1,900 recipients a minute, within your SES account's sending rate. At 14 messages a second, that's about 700 a minute, and 10,000 subscribers take about fifteen minutes.

AWS sets your account's sending rate when it grants production access. To send faster, ask AWS to raise it.

## 1. Verify your sending hostname

SES sends only from an identity you've verified. Verifying the whole hostname, rather than one address, lets any address on it send. It also sets up DKIM, which lets inboxes trust your mail.

1. Open the [SES console](https://console.aws.amazon.com/ses/), and choose the region you send from in the menu at the top right. SES keeps identities, quotas, and the sandbox separately in each region, so do every step in this one.

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
    - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1`

1. Replace `dmarc@example.com` with an address that receives mail. Reports arrive there as attachments.

[Sending-domain DNS](../reference/02-sending-domain-dns.md#dmarc-publish-a-policy-and-collect-reports) explains each record, and when to tighten DMARC.

## 3. (Optional) Set a custom MAIL FROM domain

SES sends with its own return path by default, so SPF passes for `amazonses.com` rather than for your hostname. DMARC still passes, through DKIM. A custom MAIL FROM domain makes SPF pass for your hostname too, a second check in your favor.

1. In SES, open the `send.example.com` identity. Under **Custom MAIL FROM domain**, choose **Edit**.

1. Select **Use a custom MAIL FROM domain**, and enter `bounce.send.example.com`. For **Behavior on MX failure**, keep **Use default MAIL FROM domain**. Choose **Save changes**.

1. In Cloudflare, add the two records SES lists. Replace `us-east-1` with your region:

    - **Type:** `MX`, **Name:** `bounce.send`, **Mail server:** `feedback-smtp.us-east-1.amazonses.com`, **Priority:** `10`
    - **Type:** `TXT`, **Name:** `bounce.send`, **Content:** `v=spf1 include:amazonses.com ~all`

1. Wait until SES shows the MAIL FROM domain as **Successful**.

## 4. Request production access

A new SES account starts in the sandbox. It sends only to addresses you've verified in SES, up to 200 emails a day and one a second. Ask AWS to lift those limits now, and test while you wait.

1. In SES, open the **Account dashboard**, select **View Get set up page**, and then **Request production access**.

1. Fill in the request:

    - **Mail type:** Marketing
    - **Website URL:** `https://newsletter.example.com/`

1. Check the acknowledgement, and select **Submit request**. AWS Support answers by email, and may ask how you collect addresses and handle bounces. Kestrel confirms every signup by email, and stops mailing an address that bounces or complains.

1. While you wait, verify the two addresses you test with in [Verify it works](../get-started/05-verify.md#before-you-begin), so the sandbox lets you mail them. For each, under **Identities**, choose **Create identity**, select **Email address**, and follow the link in the email AWS sends.

When AWS grants access, the **Account dashboard** shows your daily quota and your maximum send rate. You set the rate in the app in section 7.

## 5. Send bounces and complaints to SNS

SES reports what happens to each email through SNS, the AWS notification service. A configuration set says which events to report, and an SNS topic carries them to the app.

1. In SES, under **Configuration**, choose **Configuration sets**, then **Create set**. Name it `kestrel-production`, and choose **Create set**.

1. On the set's **Event destinations** tab, choose **Add destination**. Select **Hard bounces**, **Complaints**, and **Deliveries**, and choose **Next**.

1. For **Destination type**, select **Amazon SNS**. Name it `kestrel-events`, and keep **Event publishing** enabled. Choose **Next**.

1. For **SNS topic**, choose **Create SNS topic**. Make it a **Standard** topic named `kestrel-production`. Choose **Next**, then **Add destination**.

1. Make the set your hostname's default, so SES reports on every email sent from it. Open the `send.example.com` identity, and choose the **Configuration set** tab. Under **Default configuration set**, choose **Edit**, select `kestrel-production`, and save.

1. Open the topic in the [SNS console](https://console.aws.amazon.com/sns/), and copy its ARN. It looks like `arn:aws:sns:us-east-1:111122223333:kestrel-production`.

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
          "AWS:SourceArn": "arn:aws:ses:us-east-1:REPLACE_WITH_ACCOUNT_ID:configuration-set/kestrel-production"
        }
      }
    }
    ```

    Replace the topic ARN, your 12-digit account ID, and the region. Choose **Save changes**.

You subscribe the app to the topic in section 8, once it runs on SES.

## 6. Create the app's AWS key

The app sends through an IAM user whose key can only send email. That limits the harm if the key ever leaks.

1. In the [IAM console](https://console.aws.amazon.com/iam/), go to **Users**, and choose **Create user**. Name it `kestrel-production`, and leave console access off.

1. When asked for permissions, choose **Attach policies directly**, and create a policy with this JSON:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": "ses:SendEmail",
          "Resource": "*"
        }
      ]
    }
    ```

    Name the policy `kestrel-send-email`, attach it to the user, and create the user.

1. Open the user, and on the **Security credentials** tab, choose **Create access key**. For the use case, choose **Application running outside AWS**.

1. Copy the access key ID and the secret access key. AWS shows the secret only once.

## 7. Switch the provider and deploy

Store every secret before you switch. With `PROVIDER` set to `ses` and a secret missing, every request answers `500` and names the missing secret.

1. Store the access key ID, and paste it at the prompt:

    ```bash
    npx wrangler secret put AWS_ACCESS_KEY_ID --env production
    ```

1. Store the secret access key:

    ```bash
    npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
    ```

1. Store the topic ARN from section 5. The app accepts events only from this topic:

    ```bash
    npx wrangler secret put SNS_TOPIC_ARN --env production
    ```

1. Store the configuration set's name, `kestrel-production`. The app names it on every email, so SES reports on each one even without the default:

    ```bash
    npx wrangler secret put SES_CONFIGURATION_SET --env production
    ```

1. In `wrangler.jsonc`, in the `production` block's `vars`, change these values:

    ```jsonc
    "PROVIDER": "ses",
    "AWS_REGION": "us-east-1",     // ← your SES region
    "SES_MAX_SEND_RATE": "1",      // ← your maximum send rate; 1 in the sandbox
    "SUBREQUEST_BUDGET": "10000",
    ```

    When AWS grants production access, set `SES_MAX_SEND_RATE` to the maximum send rate on the **Account dashboard**, and deploy again. The app keeps to that rate, so SES doesn't throttle your send.

1. Commit the change, and push it:

    ```bash
    git commit -am "Send through Amazon SES"
    git push
    ```

1. Deploy:

    ```bash
    npm run deploy -- --env production
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

If it stays **Pending confirmation**, the app refused the request. Check that `SNS_TOPIC_ARN` matches the topic's ARN, and that the deploy in section 7 finished. Then delete the subscription, and create it again.

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

1. In the editor, **Settings → Email sender** shows Amazon SES as the email provider, and your From address.

The test sends in the next step prove the rest. In the sandbox, send them only to the addresses you verified in section 4, and to the SES test addresses that page lists.

Next, [verify it works](../get-started/05-verify.md).

## Switch an instance that already sends

Change `PROVIDER`, or move to another account with the same provider, only while no send is sending. The dashboard lists any send in progress.

When a request to a provider gets no answer, Kestrel can't know whether those recipients were mailed. Resend accepts the same request again without mailing anyone twice, because Kestrel sends it under the same key. A different provider, or another account, has never seen that key, so it delivers the post again. That's at most the recipients of the one unanswered request, but each of them gets the post twice.

To have another provider finish a halted send, accept that risk. Otherwise, fix the old account, and let the send resume there.
