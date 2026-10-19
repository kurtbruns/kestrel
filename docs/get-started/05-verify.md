# Verify it works

Some things only show up with real email: whether inboxes trust your mail, how it looks in a real mail client, and whether bounces and unsubscribes come back to the app. Check them now, while the list is empty and every email goes only to you.

In this guide, you send yourself a test email, reply to it, and check that it passes authentication. Then you set up notifications, send a real post to yourself as a subscriber, and unsubscribe. Finally, you check that bounces and complaints reach the app, read the app's logs, check that SES can send to anyone, and clean up the test subscribers.

## Before you begin

- Two email addresses you own, such as a personal address and a work address. Some steps use both. While your SES account is in the sandbox, verify both in SES first, as [Connect Amazon SES](04-ses.md#5-request-production-access) describes.
- A Gmail address, or another mail client that shows a message's original source and an **Unsubscribe** button.

## 1. Send yourself a test email

A test email goes through the same code as a real send. If the test looks right, the real send looks the same.

1. In the editor at `https://newsletter.example.com/dashboard/`, create a post with a subject, a short body, and an image.

1. Select **Send test email**, enter your address, and send it.

1. Open the email. It should arrive in your inbox, not in spam. The image loads and the subject reads as you wrote it. Its **View in browser** link opens "Nothing here yet" until the post goes out, and its unsubscribe link opens the page a subscriber sees, marked as a test and showing a sample address. Its button walks through to the confirmation, but a test email unsubscribes no one. Section 5 unsubscribes for real.

1. Reply to it, as a reader would. Reply from an address other than the inbox your From address forwards to, such as your second address. Gmail doesn't show you a message you sent when it comes back to you. Send that address a test email too if you need one. The reply arrives in the inbox you chose in [Connect Amazon SES](04-ses.md#3-receive-replies-at-your-from-address). The app can't see your forwarding, so this is the only proof that readers can reach the publisher. If the reply bounces, check the routing rule and the destination address there.

## 2. Check that it passes authentication

Inboxes trust mail that passes DKIM and DMARC for the domain it's from. Passing both is the best single sign that your mail reaches the inbox.

1. Open the test email's original source. In Gmail, open the message's menu and select **Show original**.

1. Find the `Authentication-Results` header. It shows:

    - `dkim=pass` for `send.example.com`
    - `dmarc=pass` for `send.example.com`
    - `spf=pass`, for a hostname under `send.example.com`

    With no custom MAIL FROM domain, SPF passes for `amazonses.com` instead. That's expected, and DMARC still passes.

If a check fails, compare your DNS records with the ones in [Connect Amazon SES](04-ses.md#1-verify-your-sending-hostname). [Sending-domain DNS](../reference/02-sending-domain-dns.md#verify-alignment) explains each result.

## 3. Set up notifications

Kestrel emails the notifications address when a send finishes, and right away when one runs into a problem. Notifications go through your email provider. To send them through Cloudflare instead, see [Notifications through Cloudflare's email](../guides/03-notifications.md).

1. In the editor, open **Settings → Notifications**.

1. Enter your address, and select **Save**.

1. Select **Send a test notification**. It arrives at that address.

Use your own address to test. If you're not the publisher, they set theirs in [Check your setup](../publishing/10-check-your-setup.md).

## 4. Send a real post to yourself

This is a real send, to a list of one. It proves the whole path: subscribing, confirming, scheduling, and sending.

1. Open `https://newsletter.example.com/subscribe`, and subscribe with your second address.

1. Open the confirmation email, follow its link, and select **Confirm**. In the editor, **Subscribers** shows the address as **Confirmed**.

1. Open the post, select **Schedule**, and then **Send now**. Every send waits at least five minutes before it goes out, so you can cancel a mistake.

1. Uncheck **Include in archive**. The post still goes to subscribers, but it's sent as email only: it isn't in the public archive or on the home page. That way the test proves the send without becoming the publication's first archived post, and the dashboard keeps its **Finish setting up** steps for the publisher.

1. Cancel the send, to see that canceling stops it. Then select **Schedule** and **Send now** again, check that **Include in archive** is still unchecked, and let it go.

1. When the send finishes, the post arrives at your second address. A notification arrives at your first, with the subject `Sent:` and the post's title.

If you verified this instance before Email only existed, the test post is in the archive. Open it under **Sent**, and select **Remove from archive…**.

## 5. Unsubscribe

Every email carries an unsubscribe link, and a header that lets mail clients show their own **Unsubscribe** button. Both work in one step, with no login.

1. Open the post from section 4 in your mail client. It shows an **Unsubscribe** button next to the sender.

1. Select it. In the editor, **Subscribers** shows the address as **Unsubscribed**, and later sends leave it out.

## 6. Check that bounces and complaints come back

When an address bounces or marks your mail as spam, SES tells the app through SNS. The app then stops mailing that address: a bounce suppresses it, and a complaint unsubscribes it. SES has test addresses that act out each case without reaching a real person, and the sandbox lets you mail them.

1. Open `https://newsletter.example.com/subscribe`, and subscribe each test address:

    - `bounce@simulator.amazonses.com`, which bounces
    - `complaint@simulator.amazonses.com`, which marks your mail as spam

    Each one gets a confirmation email, which bounces or is marked as spam.

1. In the editor, **Subscribers** lists the bounce address as **Pending** with a **bounced** flag, and the complaint address as **Unsubscribed**. Open its row: its page says it left by a complaint. The app mails neither again.

If the bounce address has no flag, or the complaint address is still pending, SES's events aren't reaching the app. Check the configuration set and the SNS subscription in [Connect Amazon SES](04-ses.md#6-send-bounces-and-complaints-to-sns).

## 7. Read the logs

The app writes a log line for each thing it does, and Cloudflare keeps them for a few days. Nothing else tells you if the once-a-minute schedule that sends posts stops, so it's worth knowing where to look.

1. In the Cloudflare dashboard, go to **Workers & Pages**, select `kestrel-production`, and select **Observability**.

1. Filter on `event` equal to `sweep.tick`. A line arrives every minute.

1. Filter on `event` equal to `send.completed`. Your send from section 4 is there.

1. Filter on `level` equal to `error`. A healthy instance shows nothing.

## 8. Check that SES can send to anyone

[Connect Amazon SES](04-ses.md#5-request-production-access) asked AWS for production access. Until AWS grants it, the sandbox mails only your verified addresses, so check it before you go live.

1. In SES, open the **Account dashboard** in the region the app sends from. It no longer says your account is in the sandbox, and it shows your daily quota and maximum send rate.

1. Check that `SES_MAX_SEND_RATE` in `wrangler.jsonc` matches that rate, and that you deployed after setting it, as [Connect Amazon SES](04-ses.md#8-set-the-provider-and-deploy) describes.

If the dashboard still says sandbox, AWS hasn't answered yet. Every other section works in the sandbox, so come back to this one when it does.

## 9. Clean up the test subscribers

The checks leave test addresses on the list. Erase them, so the publisher starts with only real readers.

1. In the editor, open **Subscribers**.

1. Erase `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com`. Open each one's menu (⋯), and select **Erase**.

1. Erase your second address too, if it won't be a reader.

Erasing keeps only the address, so it's never mailed again, but the person can subscribe again through the subscribe page. Erasing your own address doesn't lock you out.

When every section gives the result it describes, your instance is ready for subscribers.

Next, [go live](06-go-live.md).
