# Request production access

A new Amazon SES account starts in a sandbox: it sends only to addresses you've verified, up to 200 emails a day and one a second. Production access lifts those limits, once AWS reviews the account. This page asks AWS for it.

Ask now, before you verify the instance. AWS answers by email, and everything in [Verify it works](06-verify.md) runs in the sandbox, so you can continue there while you wait. Until AWS grants access, a signup on the publication's website gets its confirmation email only if its address is verified in SES.

In this guide, you name the publication, so AWS's reviewer finds a website that says what the newsletter is. Then you submit the request, and answer any questions AWS asks.

## Before you begin

- SES connected in the sandbox, from [Connect Amazon SES](04-ses.md). **Settings → Email sender** shows a **Sandbox** pill.
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
- Bounces and complaints reach the app, and it stops mailing those addresses automatically. [Verify it works](06-verify.md#6-check-that-bounces-and-complaints-come-back) shows it working.
- How many subscribers the newsletter expects, and how often it sends.

Once AWS grants access, **Settings → Email sender** shows a **Production** pill. Verify it works checks it in its last steps, before you go live.

Next, [verify it works](06-verify.md) while AWS reviews the request.
