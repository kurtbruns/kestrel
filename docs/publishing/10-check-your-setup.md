# Check your setup

Two checks before your readers get anything: is email getting out, and what will your readers get. The dashboard's setup steps tick each one off from what Kestrel sees, so you, and Claude, can tell what's left.

**Email has to be connected first.** Until it is, nothing can be sent, and **Send a test email** waits on the dashboard's **Connect Amazon SES** step, which [Connect Amazon SES](../get-started/05-ses.md) covers.

**Until AWS grants production access, Amazon SES mails only addresses verified in SES.** So test with a verified address, and hold the subscribe link until then. The dashboard's **Request production access** step says where AWS's review stands, and [Request production access](../get-started/06-production-access.md) covers the request.

## 1. Send a test email

Choose **Template** in the sidebar, then **Send test email**, and send a sample post to your own inboxes. This is the test that proves email gets out: signups stay closed until SES takes an email, and the step is checked off once it does. When it arrives, check:

- **The From name and address,** which readers see first. They're set when your instance is deployed.
- **Where it lands:** the inbox, Promotions, or spam. If it lands in spam, check your sending domain's records, as [Sending-domain DNS](../reference/02-sending-domain-dns.md) describes.
- **A reply.** Reply to the test, and check that it reaches your inbox. Kestrel never sees replies, so this depends on [forwarding your From address](../get-started/05-ses.md#8-receive-replies-at-your-from-address).

If SES refuses the test, the dashboard says why in red above the steps, with the fix. Send another test once it's made.

## 2. Get notified

Under **Settings → Notifications**, add your address under **Send notifications to** with **Add inbox**, save, and choose **Send a test notification**. It goes to each address. If someone else runs your instance, add their address too, so a problem reaches both of you. Kestrel then emails you when a send finishes or needs you, as [Notifications](06-troubleshooting.md#notifications) lists. The step is checked off once an address is saved, and points back to Settings if the last notification didn't arrive.

## 3. See what your readers get

Open your subscribe page from **Settings → Ways to subscribe**, subscribe with a personal address, and confirm. You see what a new reader sees, and you appear under **Subscribers** as **Confirmed**.

Then, once your first post is scheduled, **Send a test email for your first post** from its page. Scheduling makes the exact email your list will get, so this test is what goes out, and the step is checked off once it's sent. A test sent from a draft is a preview and doesn't count. [Write and send a post](04-write-a-post.md) covers scheduling.

**If you're bringing more than about 1,000 subscribers, upgrade to Cloudflare's Workers Paid plan before you import.** [Bring your existing list](01-your-list.md#limits) explains why.
