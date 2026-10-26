# Check your setup

Before your readers get anything, check three things yourself: your email arrives and replies reach you, subscribing works, and problems will reach you.

**Email has to be connected first.** Until it is, nothing can be sent, and the dashboard's checklist shows **Connect Amazon SES** in place of this step, as [Connect Amazon SES](../get-started/04-ses.md) describes.

## 1. Send yourself a test

Choose **Template** in the sidebar, then **Send test email**, and send a sample post to your own inboxes. When it arrives, check:

- **The From name and address,** which readers see first. They're set when your instance is deployed.
- **Where it lands:** the inbox, Promotions, or spam. If it lands in spam, check your sending domain's records, as [Sending-domain DNS](../reference/02-sending-domain-dns.md) describes.
- **A reply.** Reply to the test, and check that it reaches your inbox. Kestrel never sees replies, so this depends on [forwarding your From address](../get-started/04-ses.md#8-receive-replies-at-your-from-address).

## 2. Subscribe yourself

Open your subscribe page from **Settings → Ways to subscribe**, subscribe with a personal address, and confirm. You see what a new reader sees, and you appear under **Subscribers** as **Confirmed**.

## 3. Set your notifications address

Under **Settings → Notifications**, fill in **Send notifications to**, save, and choose **Send a test notification**. Kestrel then emails you when a send finishes or needs you, as [Notifications](06-troubleshooting.md#notifications) lists.

**If you're bringing more than about 1,000 subscribers, upgrade to Cloudflare's Workers Paid plan before you import.** [Bring your existing list](01-your-list.md#limits) explains why.
