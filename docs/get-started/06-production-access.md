# Request production access

Once Amazon SES is connected, request production access to start sending email to subscribers. You may want to start this process sooner rather than later, since AWS reviews each request, and its first answer can take up to 96 hours.

In this guide, you name the publication, submit the request, and answer any questions AWS asks. Then, once AWS answers, you check that it granted access.

## Before you begin

- SES connected in the sandbox, from [Connect Amazon SES](05-ses.md). **Settings → Email sender** shows a **Sandbox** pill.
- The publication's name and tagline, from the publisher.

## 1. Name the publication

AWS may visit the publication's website to review the request. On a new instance with no posts, the tagline is the only line on the home page that says what the newsletter is about.

1. In the editor, open **Settings → Publication identity**, and enter the name and tagline. Both can change later.

1. If the newsletter will mainly sell something, add a mailing address there too, with **Add a mailing address**. [When to provide a mailing address](../publishing/03-name-your-publication.md#when-to-provide-a-mailing-address) explains when US law asks for one.

1. Open `https://newsletter.example.com/` in a browser. The home page shows the tagline, and a subscribe form.

## 2. Submit the request

AWS reviews each request by hand, for the region the app sends from.

1. In the [SES console](https://console.aws.amazon.com/ses/), choose the region the app sends from, the one in `AWS_REGION`. Open the **Account dashboard**, select **View Get set up page**, and then **Request production access**.

1. Fill in the request:

    - **Mail type:** Marketing
    - **Website URL:** `https://newsletter.example.com/`

    Leave the other fields as they are.

1. Check the acknowledgement, and select **Submit request**. AWS Support answers by email.

1. Within about ten minutes, the editor's **Settings → Email sender** says AWS is reviewing your request for production access. It also says when AWS grants or denies it.

## 3. Answer AWS's questions

AWS Support may ask how you collect addresses and handle bounces before it decides. If it asks for more detail, or denies the request, reply in the support case, or open a new request from the **Account dashboard**. Say how Kestrel handles the list:

- Signups use double opt-in: each subscriber confirms by email before joining the list.
- Every post offers one-click unsubscribe.
- Bounces and complaints reach the app, and it stops mailing those addresses automatically. [Verify it works](07-verify.md#6-check-that-bounces-and-complaints-come-back) shows it working.
- How many subscribers the newsletter expects, and how often it sends.

## 4. Check that AWS granted it

Until AWS grants production access, SES sends only to your verified addresses, so check it before you go live.

1. In the editor, open **Settings → Email sender**. The email provider reads **Production**, and **Send rate** shows your account's maximum send rate and daily quota, "from your SES account". Claude, or a script signed in with `npx kestrel login`, reads the same from the API:

    ```bash
    npx kestrel api GET /api/provider
    ```

    Its `state` is `production`.

1. If it reads **Sandbox**, or `state` is `sandbox`, AWS hasn't granted access yet. Come back to this section when it does, and check the email AWS Support sends for questions.

1. If it says Kestrel's AWS key needs permission to read your account, or `unknown_reason` is `permission`, allow the `kestrel-send-email` policy `ses:GetAccount`, as [Connect Amazon SES](05-ses.md#5-create-the-apps-aws-key) shows. Look again in an hour, since the app asks again hourly. If it reads only "Amazon SES", or `unknown_reason` is `not_checked`, the app hasn't asked yet: look again in ten minutes. The SES **Account dashboard** shows the same facts.

Next, [verify it works](07-verify.md).
