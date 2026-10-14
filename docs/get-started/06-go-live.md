# Go live

This last step makes the newsletter yours, and tells people where to subscribe.

In this guide, you check your publication's name, add a logo, and share your subscribe link. You also see what to change as your list grows.

## Before you begin

- SES production access, granted in the region the app sends from. [Connect Amazon SES](04-ses.md#5-request-production-access) asks for it.
- `SES_MAX_SEND_RATE` set to the maximum send rate on the SES **Account dashboard**, and deployed. [Connect Amazon SES](04-ses.md#8-set-the-provider-and-deploy) sets it to `1` for the sandbox.

In the sandbox, SES refuses the confirmation email to any address you haven't verified, so those signups fail. A post reaches only the addresses you verified in SES.

## 1. Name your publication

Your publication's name, tagline, and logo appear on the public pages readers see, and in every email. You named it in [Connect Amazon SES](04-ses.md#5-request-production-access). Check those, and add a logo before anyone sees your pages.

1. In the editor, open **Settings → Publication identity**.

1. Check the name and tagline, and upload a logo.

1. **(Optional)** Select **Add a mailing address**. US law asks for a postal address in promotional email, and a P.O. box works. The built-in email template prints it in every email's footer.

## 2. Share your subscribe link

Readers subscribe on a page the app hosts. Every signup confirms by email before it joins your list.

1. In the editor, open **Settings → Ways to subscribe**.

1. Copy your subscribe page's link, `https://newsletter.example.com/subscribe`, and share it.

1. **(Optional)** To take signups on your own website, copy the embeddable subscribe form from the same page, and paste it into your site.

1. **(Optional)** Cap how often one visitor can submit the form. The app already sends any one address at most one confirmation every 15 minutes. A Cloudflare rule can also limit each visitor, and the Free plan includes one. See [Rate-limit the subscribe form](../guides/05-rate-limit.md).

## As your list grows

A new instance runs on Cloudflare's free Workers plan. As your list grows, three limits come into play.

- **Your SES quota.** AWS caps how many emails your account sends a day. A send that hits the cap waits, and the app emails you. It resumes on its own once the quota frees up, or after AWS raises it.
- **How fast a send goes out.** A send goes out a slice at a time, one slice a minute. SES takes one request a second, of up to 50 recipients, and no more recipients a second than your account's maximum send rate. So each request carries one second of that rate, up to 50.
- **Your database's daily writes.** On the free plan, D1, the database the app runs on, allows 100,000 rows written a day. Past that, it refuses every query until midnight UTC, and the whole app stops: sends, signups, the public pages, and the editor.

It's recommended to move to the $5 Workers Paid plan from about 5,000 subscribers. A send writes about 14 database rows a recipient, delivery receipts included. So one send uses up the free plan's day at about 7,000 recipients, and sooner when an import or anything else writes that day. Workers Paid counts [D1's writes](https://developers.cloudflare.com/d1/platform/pricing/) by the month instead, with 50 million included, and never stops the database for them. On the free plan, the app warns you before a send to more than 5,000 recipients, in the Schedule dialog and on the scheduled post. A smaller send that fires on a day you've imported subscribers gets the same warning on the scheduled post. The app also warns before an import that would use most of a day's writes with the day's earlier imports. It never stops you, since your account may already be on Workers Paid.

The free Workers plan sends four requests a minute. At 14 messages a second, a common starting rate, that's 56 recipients a minute, and 1,000 subscribers take about 18 minutes. At 50 a second or more, it's 200 a minute.

To send faster, first ask AWS to raise your maximum send rate to 50, which costs nothing, then set [`SES_MAX_SEND_RATE`](../reference/01-configuration.md#ses_max_send_rate) to match, and deploy again. A rate above 50 adds nothing on the free plan, where a rate of 50 sends 5,000 subscribers in about 25 minutes. A larger list belongs on Workers Paid for its database writes anyway. On Workers Paid, set [`SUBREQUEST_BUDGET`](../reference/01-configuration.md#subrequest_budget) to `10000`. It sends about 50 requests a minute: about 700 recipients at 14 a second, and about 2,500 at 50 or more.

## Check it

1. The SES **Account dashboard**, in the region the app sends from, no longer says your account is in the sandbox.

1. `https://newsletter.example.com/subscribe` shows your publication's name and logo.

1. `https://newsletter.example.com/` shows your publication's name, and the post you sent yourself in [Verify it works](05-verify.md#4-send-a-real-post-to-yourself).

## What's next

Each of these guides stands on its own. Pick the ones you want.

- [Connect Claude to the API](../guides/01-connect-claude.md), so Claude can draft, proofread, and schedule posts through the same API the editor uses.
- [Notifications through Cloudflare's email](../guides/03-notifications.md), so you hear about problems even when your email provider has stopped sending.

When a new release comes out, [Upgrade to a new release](../guides/07-upgrade.md) shows how to move to it.
