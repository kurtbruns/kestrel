# Check your setup

Before your readers get anything, see it arrive yourself, and make sure a problem will reach you without your watching for it. Send yourself a test, subscribe yourself, and set where Kestrel emails you. It's the second step of **Set up your publication** on your dashboard.

This page covers whether email is connected, what to check in a test, how Kestrel tells you something's wrong, and what changes as your list grows.

## Email is connected

If nothing on your dashboard says otherwise, it is. While no email provider is connected, Kestrel says so wherever a send would fail. Until your first post, the dashboard's checklist shows **Connect Amazon SES** in place of this step. After that, an amber line on the dashboard reads "No email provider connected, so nothing can be sent yet." The Schedule dialog says the post can't be scheduled yet, and its buttons are unavailable.

**Settings → Email sender** shows your From address, sending domain, and email provider, read-only. Connecting a provider is for whoever runs your Kestrel, in [Connect Amazon SES](../get-started/04-ses.md) and [Verify it works](../get-started/05-verify.md).

## Send yourself a test

A test shows you exactly what readers get, and you can send one before you write any post. Choose **Template** in the sidebar, then **Send test email**, and send a sample post to your own inboxes. [Name your publication](03-name-your-publication.md) covers the template, and [Write your first post](04-write-a-post.md#test-emails) covers what a test is.

When it arrives, look at:

- **The From name and address.** They're what readers see first.
- **Your logo and name,** as your template prints them.
- **Where it lands:** the inbox, Promotions, or spam. If it lands in spam, tell whoever runs your Kestrel. [Sending-domain DNS](../reference/02-sending-domain-dns.md) covers what they check.
- **A reply.** Reply to the test, and check that it reaches your inbox. Kestrel never sees replies, so this depends on [forwarding set up by whoever runs your Kestrel](../get-started/04-ses.md#3-receive-replies-at-your-from-address).

## Subscribe yourself

Subscribing with a personal address shows you what a new reader sees. Use your public subscribe page, at your publication's address followed by `/subscribe`. The confirmation email arrives with your wording. Once you confirm, you appear under **Subscribers** as **Confirmed**. [Share your subscribe link](09-share-your-subscribe-link.md) covers the page and the confirmation email.

## How Kestrel tells you something's wrong

Kestrel tells you in three places: your inbox, the dashboard, and the Schedule dialog. Most of the time, none of them says anything.

- **Notifications.** Set your address under **Settings → Notifications**, in **Send notifications to**, and save. **Send a test notification** checks that one arrives. With no address set, nothing is emailed. [After a send](06-after-a-send.md#notifications) lists what you're told.
- **The dashboard's health block.** It appears only when something needs attention, and stays until it clears. Red needs you to act, and amber is worth a look.
- **Warnings when you schedule.** The Schedule dialog warns you before you schedule something that could go wrong. [Scheduling and sending](05-scheduling-and-sending.md#warnings-in-the-schedule-dialog) covers them.

Whoever runs your Kestrel chooses how notifications are sent. [Notifications through Cloudflare's email](../guides/03-notifications.md) covers a way that reaches you even when your email provider refuses your account.

## As your list grows

A growing list meets a few limits, and Kestrel tells you before or when it reaches each one. Raising each is a change for whoever runs your Kestrel, on the plans and accounts they chose, as [Go live](../get-started/06-go-live.md#as-your-list-grows) describes.

- **Your provider's daily sending quota.** A send that hits it waits, and the dashboard shows why. It resumes on its own once the quota frees up, and nobody is mailed twice. Amazon SES reports a spent quota as refusing your account, so its email reaches you only if your notifications go another way ([Notifications](06-after-a-send.md#notifications)).
- **How long a send takes.** It grows with your list, and depends on your provider's sending rate and the hosting plan whoever runs your Kestrel chose. [Go live](../get-started/06-go-live.md#as-your-list-grows) gives the rates.
- **Daily database writes on the free hosting plan.** A large send or import can use up the day's writes. Then the whole app stops until midnight UTC. On that plan, Kestrel warns you before a send to more than 5,000 recipients. It also warns you before an import that would use most of the day's writes. Neither warning stops you. [Bring your existing list](01-your-list.md#limits) explains more.

From about 5,000 subscribers, it's recommended that whoever runs your Kestrel moves to the paid hosting plan, which has no daily limit on writes.

Next, [Bring your existing list](01-your-list.md).
