# Go live

Your instance works. What's left is making it yours, and telling people where to subscribe.

In this guide, you name your publication and share your subscribe link. You also see what to change as your list grows.

## 1. Name your publication

Your publication's name, tagline, and logo appear on the public pages readers see, and in every email. Set them before anyone sees those pages. Until you do, the name in your From address stands in.

1. In the editor, open **Settings → Publication identity**.

1. Enter the name and tagline, and upload a logo.

1. **(Optional)** Select **Add a mailing address**. US law asks for a postal address in promotional email, and a P.O. box works. The built-in email template prints it in every email's footer.

## 2. Share your subscribe link

Readers subscribe on a page the app hosts. Every signup confirms by email before it joins your list.

1. In the editor, open **Settings → Ways to subscribe**.

1. Copy your subscribe page's link, `https://newsletter.example.com/subscribe`, and share it.

1. **(Optional)** To take signups on your own website, copy the embeddable subscribe form from the same page, and paste it into your site.

1. **(Optional)** Cap how often one visitor can submit the form. The app already sends any one address at most one confirmation every 15 minutes. A Cloudflare rule can also limit each visitor, and the Free plan includes one. See [Rate-limit the subscribe form](../guides/05-rate-limit.md).

## As your list grows

A new instance runs on free plans. As your list grows, two limits come into play.

- **Your email provider's limits.** Resend's free plan sends up to 100 emails a day. A send that hits the limit waits, and the app emails you. It resumes on its own once the limit lifts, or after you upgrade your Resend plan, and mails no one twice. For a large list, [Amazon SES](../guides/02-ses.md) may cost less.
- **How fast a send goes out.** On Cloudflare's free Workers plan, Resend sends about 400 recipients a minute. On the $5 Workers Paid plan, set [`SUBREQUEST_BUDGET`](../reference/01-configuration.md#vars) to send far more each minute.

## Check it

1. `https://newsletter.example.com/subscribe` shows your publication's name and logo.

1. `https://newsletter.example.com/` shows your publication's name, and the post you sent yourself in [Verify it works](05-verify.md#4-send-a-real-post-to-yourself).

## What's next

Each of these guides stands on its own. Pick the ones you want.

- [Connect Claude to the API](../guides/01-connect-claude.md), so Claude can draft, proofread, and schedule posts through the same API the editor uses.
- [Notifications through Cloudflare's email](../guides/03-notifications.md), so you hear about problems even when your email provider has stopped sending.
- [Put the archive on your website](../guides/04-archive-website.md), at `example.com/archive`.
- [Add a staging environment](../guides/06-staging.md), to try a change before it reaches production.

When a new release comes out, [Upgrade to a new release](../guides/07-upgrade.md) shows how to move to it.
