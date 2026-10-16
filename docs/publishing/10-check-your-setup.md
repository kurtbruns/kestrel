# Check your setup

Before your readers get anything, see it arrive yourself, and make sure a problem will reach you without your watching for it. Send yourself a test and reply to it, subscribe yourself, and set where Kestrel emails you.

If you're bringing a list of more than about 1,000 subscribers, upgrade to Cloudflare's Workers Paid plan before you import it. Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. [As your list grows](../guides/09-as-your-list-grows.md) walks through the upgrade.

## Send yourself a test

Choose **Template** in the sidebar, then **Send test email**, and send a sample post to your own inboxes. When it arrives, check:

- **The From name and address,** which readers see first. They're set when Kestrel is deployed ([Connect Amazon SES](../get-started/04-ses.md#8-set-the-provider-and-deploy)).
- **Where it lands:** the inbox, Promotions, or spam. If it lands in spam, check your sending domain's records, as [Sending-domain DNS](../reference/02-sending-domain-dns.md) describes.
- **A reply.** Reply to the test, and check that it reaches your inbox. Kestrel never sees replies, so this depends on [forwarding your From address](../get-started/04-ses.md#3-receive-replies-at-your-from-address).

## Subscribe yourself

Open your subscribe page, from the link under **Settings → Ways to subscribe**, and subscribe with a personal address. Then confirm. You see what a new reader sees, and you then appear under **Subscribers** as **Confirmed**. [Share your subscribe link](09-share-your-subscribe-link.md) covers the page and the confirmation email.

## Set your notifications address

Under **Settings → Notifications**, fill in **Send notifications to**, save, and choose **Send a test notification**. Kestrel then emails you when a send finishes or needs you. [Notifications](06-troubleshooting.md#notifications) lists what you're told, and why a second way to send them is worth asking for.

## If email isn't connected

Until an email provider is connected, nothing can be sent, and the dashboard says so. The checklist shows **Connect Amazon SES** in place of this step, as [Connect Amazon SES](../get-started/04-ses.md) describes. **Settings → Email sender** shows your From address, sending domain, and provider, read-only.

## As your list grows

A growing list meets your Amazon SES daily sending quota, longer sends, and on Cloudflare's free Workers plan, a cap on daily database writes. Kestrel tells you when you reach each one (on the free plan, from about 1,000 subscribers), and [As your list grows](../guides/09-as-your-list-grows.md) covers raising each.

