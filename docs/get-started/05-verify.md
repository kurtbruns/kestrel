# Verify it works

This page checks your instance end to end with real email, while the list is empty and every email goes only to you. You confirm that inboxes trust your mail, that posts look right in a mail client, and that bounces, complaints, and unsubscribes reach the app.

In this guide, you send yourself a test email, reply to it, and check that it passes authentication. Then you ask AWS for production access. While AWS reviews it, you set up notifications, send a real post to yourself as a subscriber, and unsubscribe. Finally, you check that bounces and complaints reach the app, read the app's logs, check that SES can send to anyone, and clean up the test subscribers.

## Before you begin

- The two addresses you verified in SES in [Connect Amazon SES](04-ses.md#3-verify-your-test-addresses). Some steps use both.
- A Gmail address, or another mail client that shows a message's original source and an **Unsubscribe** button.

## 1. Send yourself a test email

A test email goes through the same code as a real send. If the test looks right, the real send looks the same.

1. In the editor at `https://newsletter.example.com/dashboard/`, create a post with a subject, a short body, and an image.

1. Select **Send test email**, enter your address, and send it.

1. Open the email. It arrives in your inbox, not in spam, the image loads, and the subject reads as you wrote it. Its links work, but a test email unsubscribes no one; section 6 unsubscribes for real.

1. Send a test email to your second address, not the publisher's inbox, and reply to it from there, as a reader would. The reply arrives in the publisher's inbox, the one you chose in [Connect Amazon SES](04-ses.md#8-receive-replies-at-your-from-address), or in your From address's own mailbox if you skipped forwarding. If it bounces, check the routing rule and the destination address there.

## 2. Check that it passes authentication

Inboxes trust mail that passes DKIM and DMARC for the domain it's from. Passing both is the best single sign that your mail reaches the inbox.

1. Open the test email's original source. In Gmail, open the message's menu and select **Show original**.

1. Find the `Authentication-Results` header. It shows:

    - `dkim=pass` for `send.example.com`
    - `dmarc=pass` for `send.example.com`
    - `spf=pass`, for a hostname under `send.example.com`

    If SPF passes for `amazonses.com` instead, SES couldn't read your custom MAIL FROM domain's MX record, and used its own. DMARC still passes, but check the MAIL FROM records from [Connect Amazon SES](04-ses.md#1-verify-your-sending-hostname).

If a check fails, compare your DNS records with the ones in [Connect Amazon SES](04-ses.md#1-verify-your-sending-hostname). [Sending-domain DNS](../reference/02-sending-domain-dns.md#verify-alignment) explains each result.

## 3. Request production access

A new SES account sends only to the addresses you've verified, up to 200 emails a day and one a second. Production access lifts those limits, once AWS reviews the account. Ask now: the app is connected, a test email has passed authentication, and the publication's website shows a live subscribe form. A signup there gets its confirmation email only once AWS grants access, AWS's own included. Every other section on this page works in the sandbox, so continue while you wait.

1. Name the publication, since AWS may visit its website to review the request. In the editor, open **Settings → Publication identity**, and enter the name and tagline, or ask the publisher for them. On a new instance with no posts, the tagline is the only line on the home page that says what the newsletter is about. Both can change later.

1. If the newsletter will mainly sell something, add a mailing address there too, with **Add a mailing address**. [When to provide a mailing address](../publishing/03-name-your-publication.md#when-to-provide-a-mailing-address) explains when US law asks for one.

1. In SES, in the region the app sends from, open the **Account dashboard**, select **View Get set up page**, and then **Request production access**.

1. Fill in the request:

    - **Mail type:** Marketing
    - **Website URL:** `https://newsletter.example.com/`

    Leave the other fields as they are.

1. Check the acknowledgement, and select **Submit request**. AWS Support answers by email, and may ask how you collect addresses and handle bounces.

If AWS asks for more detail, or denies the request, reply in the support case, or open a new request from the **Account dashboard**. Say how Kestrel handles the list:

- Signups use double opt-in: each subscriber confirms by email before joining the list.
- Every post offers one-click unsubscribe.
- Bounces and complaints reach the app, and it stops mailing those addresses automatically. Section 7 shows it working.
- How many subscribers the newsletter expects, and how often it sends.

## 4. Set up notifications

Kestrel emails the notifications address when a send finishes, and right away when one runs into a problem.

1. In the editor, open **Settings → Notifications**.

1. Enter your address, and select **Save**.

1. Select **Send a test notification**. It arrives at that address.

Use your own address to test. If you're not the publisher, they set theirs in [Check your setup](../publishing/10-check-your-setup.md).

## 5. Send a real post to yourself

This is a real send, to a list of one. It proves the whole path: subscribing, confirming, scheduling, and sending.

1. Open `https://newsletter.example.com/subscribe`, and subscribe with your second address.

1. Open the confirmation email, follow its link, and select **Confirm subscription**. In the editor, **Subscribers** shows the address as **Confirmed**.

1. Open the post, select **Schedule**, and then **Send now**.

1. In the **Send now?** dialog, uncheck **Include in archive**, and select **Send now**. The post goes out as email only, so it doesn't become the publication's first archived post. The dashboard keeps its **Finish setting up** steps for the publisher. Every send waits at least five minutes before it goes out, so you can cancel a mistake.

1. Cancel the send, to see that canceling stops it. Then send it again the same way, with **Include in archive** unchecked, and let it go.

1. When the send finishes, the post arrives at your second address. A notification arrives at your first, with the subject `Sent:` and the post's title.

## 6. Unsubscribe

Every email carries an unsubscribe link, and a header that lets mail clients show their own **Unsubscribe** button. Both work in one step, with no login.

1. Open the post from section 5 in your mail client. It shows an **Unsubscribe** button next to the sender.

1. Select it. In the editor, **Subscribers** shows the address as **Unsubscribed**, and later sends leave it out.

## 7. Check that bounces and complaints come back

When an address bounces or marks your mail as spam, SES tells the app through SNS. The app then stops mailing that address: a bounce suppresses it, and a complaint unsubscribes it. SES has test addresses that act out each case without reaching a real person, and the sandbox lets you mail them.

1. Open `https://newsletter.example.com/subscribe`, and subscribe each test address:

    - `bounce@simulator.amazonses.com`, which bounces
    - `complaint@simulator.amazonses.com`, which marks your mail as spam

    Each one gets a confirmation email, which bounces or is marked as spam.

1. In the editor, **Subscribers** lists the bounce address as **Pending** with a **bounced** flag, and the complaint address as **Unsubscribed**. Open its row: its page says it left by a complaint. The app mails neither again.

If the bounce address has no flag, or the complaint address is still pending, SES's events aren't reaching the app. Check the configuration set in [Send bounces and complaints to the app](04-ses.md#4-send-bounces-and-complaints-to-the-app), and the subscription in [Subscribe the app to the topic](04-ses.md#7-subscribe-the-app-to-the-topic).

## 8. Read the logs

The app writes a log line for each thing it does, and Cloudflare keeps them for a few days, depending on your plan. Nothing else tells you if the once-a-minute schedule that sends posts stops, so it's worth knowing where to look.

1. In the Cloudflare dashboard, go to **Workers & Pages**, select `kestrel-production`, and select **Observability**.

1. Filter on `event` equal to `sweep.tick`. A line arrives every minute.

1. Filter on `event` equal to `send.completed`. Your send from section 5 is there.

1. Filter on `event` equal to `send.scheduled`. Your two sends from section 5 are there, and `send.canceled` shows the one you canceled. Each line that records an action says who took it. Its `principal` is `human` or `service`, and its `client` names the program a person used, such as `editor`.

1. Filter on `level` equal to `error`. A healthy instance shows nothing.

To follow one send, narrow the time range and filter on its `sendId`, since a long range may show only a sample. On the Free plan, Cloudflare stops keeping logs for the rest of the day once its daily allowance is used, as [its pricing page](https://developers.cloudflare.com/observability/pricing/) describes.

## 9. Check that SES can send to anyone

Section 3 asked AWS for production access. Until AWS grants it, the sandbox mails only your verified addresses, so check it before you go live.

1. In SES, open the **Account dashboard** in the region the app sends from. It no longer says your account is in the sandbox, and it shows your daily quota and maximum send rate.

1. Check that `SES_MAX_SEND_RATE` in `wrangler.jsonc` matches that rate, and that you deployed after setting it, as [Connect Amazon SES](04-ses.md#6-set-the-provider-and-deploy) describes.

If the dashboard still says sandbox, AWS hasn't answered yet. Come back to this section when it does, and check the email AWS Support sends for questions.

## 10. Clean up the test subscribers

The checks leave test addresses on the list. Erase them, so the publisher starts with only real readers.

1. In the editor, open **Subscribers**.

1. Erase `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com`. Open each one's menu (⋯), and select **Erase**.

1. Erase your second address too, if it won't be a reader.

Erasing keeps only the address, so it's never mailed again, but the person can subscribe again through the subscribe page. Erasing your own address doesn't lock you out.

When every section gives the result it describes, your instance is ready for subscribers. If one doesn't once the app is running, [Troubleshooting](../publishing/06-troubleshooting.md) says what the app's messages mean and where each is fixed.

Next, [go live](06-go-live.md).
