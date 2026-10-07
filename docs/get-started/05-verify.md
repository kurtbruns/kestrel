# Verify it works

Some things only show up with real email: whether inboxes trust your mail, how it looks in a real mail client, and whether bounces and unsubscribes come back to the app. Check them now, while your list is empty and every email goes only to you.

In this guide, you send yourself a test email and check that it passes authentication. Then you set up your notifications, send a real post to yourself as a subscriber, and unsubscribe. Finally, you check that bounces and complaints reach the app, and read the app's logs.

## Before you begin

- Two email addresses you own, such as a personal address and a work address. Some steps use both.
- A Gmail address, or another mail client that shows a message's original source and an **Unsubscribe** button.

## 1. Send yourself a test email

A test email goes through the same code as a real send. If the test looks right, the real send looks the same.

1. In the editor at `https://newsletter.example.com/dashboard/`, create a post with a subject, a short body, and an image.

1. Select **Send test email**, enter your address, and send it.

1. Open the email. It should arrive in your inbox, not in spam. The image loads, the links work, and the subject reads as you wrote it.

## 2. Check that it passes authentication

Inboxes trust mail that passes DKIM and DMARC for the domain it's from. Passing both is the best single sign that your mail reaches the inbox.

1. Open the test email's original source. In Gmail, open the message's menu and select **Show original**.

1. Find the `Authentication-Results` header. It shows:

    - `dkim=pass` for `send.example.com`
    - `dmarc=pass` for `send.example.com`
    - `spf=pass`, for a hostname under `send.example.com`

    With Amazon SES and no custom MAIL FROM domain, SPF passes for `amazonses.com` instead. That's expected, and DMARC still passes.

If a check fails, compare your DNS records with the ones in [Connect Resend](04-resend.md#1-verify-your-sending-hostname). [Sending-domain DNS](../reference/02-sending-domain-dns.md#verify-alignment) explains each result.

## 3. Set up your notifications

Kestrel emails you when a send finishes, and right away when one runs into a problem. Notifications go through your email provider. To send them through Cloudflare instead, see [Notifications through Cloudflare's email](../guides/03-notifications.md).

1. In the editor, open **Settings → Notifications**.

1. Enter your address, and select **Save**.

1. Select **Send a test notification**. It arrives at that address.

## 4. Send a real post to yourself

This is a real send, to a list of one. It proves the whole path: subscribing, confirming, scheduling, and sending.

1. Open `https://newsletter.example.com/subscribe`, and subscribe with your second address.

1. Open the confirmation email, follow its link, and select **Confirm**. In the editor, **Subscribers** shows the address as **Confirmed**.

1. Open your post, select **Schedule**, and then **Send now**. Every send waits at least five minutes before it goes out, so you can cancel a mistake.

1. Cancel the send, to see that canceling stops it. Then select **Send now** again, and let it go.

1. When the send finishes, the post arrives at your second address. A notification arrives at your first, with the subject `Sent:` and the post's title.

## 5. Unsubscribe

Every email carries an unsubscribe link, and a header that lets mail clients show their own **Unsubscribe** button. Both work in one step, with no login.

1. Open the post from section 4 in your mail client. It shows an **Unsubscribe** button next to the sender.

1. Select it. In the editor, **Subscribers** shows the address as **Unsubscribed**, and later sends leave it out.

## 6. Check that bounces and complaints come back

When an address bounces or marks your mail as spam, your provider tells the app through the webhook. The app then stops mailing that address. Your provider has test addresses that act out each case without reaching a real person.

1. Open `https://newsletter.example.com/subscribe`, and subscribe each test address for your provider:

    | Provider | Bounces | Marks as spam |
    | --- | --- | --- |
    | Resend | `bounced@resend.dev` | `complained@resend.dev` |
    | Amazon SES | `bounce@simulator.amazonses.com` | `complaint@simulator.amazonses.com` |

    Each one gets a confirmation email, which bounces or is marked as spam.

1. In the editor, **Subscribers** lists both addresses as **Pending**, each with a **Suppressed** flag. The app never mails a suppressed address again.

If an address has no flag, the webhook isn't reaching the app. Check its URL and signing secret in [Connect Resend](04-resend.md#4-add-the-webhook).

## 7. Read the logs

The app writes a log line for each thing it does, and Cloudflare keeps them for a few days. Nothing else tells you if the once-a-minute schedule that sends your posts stops, so it's worth knowing where to look.

1. In the Cloudflare dashboard, go to **Workers & Pages**, select `kestrel-production`, and select **Observability**.

1. Filter on `event` equal to `sweep.tick`. A line arrives every minute.

1. Filter on `event` equal to `send.completed`. Your send from section 4 is there.

1. Filter on `level` equal to `error`. A healthy instance shows nothing.

When every section gives the result it describes, your instance is ready for subscribers.

Next, [go live](06-go-live.md).
