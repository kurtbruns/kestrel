# Request production access

Once Amazon SES is connected, request production access to start sending email to subscribers. AWS reviews each request by hand, and its first answer can take up to 96 hours. Its reviewer looks for what's now in place: a website that says what the newsletter is, a subscribe form that confirms each signup by email, and bounces and complaints that reach the app.

In this guide, you name the publication, submit the request, and answer any questions AWS asks. Then, once AWS answers, you check that it granted access.

## Before you begin

- Amazon SES connected, from [Connect Amazon SES](05-ses.md).
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

AWS Support may ask how you collect addresses and handle bounces before it decides. A newsletter may be asked for more detail, or denied the first time, sometimes without a reason. A reply that explains how the list is built usually gets further than a new request. If it asks for more detail, or denies the request, reply in the support case, or open a new request from the **Account dashboard**.

In the sandbox, the subscribe form's confirmation email reaches only addresses verified in SES. If AWS's reviewer tries the form, say that this is why no confirmation arrives. In your reply, cover:

- That signups use double opt-in: each subscriber confirms by email before joining the list.
- That every post offers one-click unsubscribe.
- That bounces and complaints reach the app, and it stops mailing those addresses automatically. [Verify it works](07-verify.md#6-check-that-bounces-and-complaints-come-back) shows it working.
- That the publication's website shows what the newsletter is, and how readers subscribe.
- That an imported list was gathered with opt-in on the previous service.
- How many subscribers the newsletter expects, and how often it sends.

## 4. Check that AWS granted it

Until AWS grants production access, SES sends only to your verified addresses, so check it before you go live.

1. In the editor, open **Settings → Email sender**. The email provider reads **Production**. From the API, `npx kestrel api GET /api/provider` shows `state` as `production`.

1. If it reads **Sandbox**, AWS hasn't granted access yet. Meanwhile, continue with [Verify it works](07-verify.md), which runs in the sandbox. Come back to this section when AWS answers, and check the email AWS Support sends for questions.

1. If it says Kestrel's AWS key needs permission to read your account, select **Add the permission** and follow the step it opens. The app checks again within an hour.

1. If it reads just "Amazon SES", with nothing under it, the app hasn't heard from SES yet. Look again in ten minutes. If it still reads that way, the app's logs say why, in their `provider.account_checked` line, as [Read the logs](07-verify.md#7-read-the-logs) describes.

Next, [verify it works](07-verify.md).
