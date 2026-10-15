# Go live

This last step hands the newsletter to whoever writes it, which may be you.

In this guide, you set up the publication itself, following the Publishing docs, and see what to read next.

## Before you begin

- SES production access, granted in the region the app sends from. [Connect Amazon SES](04-ses.md#5-request-production-access) asks for it.
- `SES_MAX_SEND_RATE` set to the maximum send rate on the SES **Account dashboard**, and deployed. [Connect Amazon SES](04-ses.md#8-set-the-provider-and-deploy) sets it to `1` for the sandbox.

In the sandbox, SES refuses the confirmation email to any address you haven't verified, so those signups fail. A post reaches only the addresses you verified in SES.

## 1. Set up your publication

The rest happens in the editor, and the Publishing docs walk through it in the order of the dashboard's checklist. You name the publication, check the setup, bring an existing list, write the first post, and share the subscribe link.

1. Open the editor at `https://newsletter.example.com/dashboard/`.

1. Follow the Publishing docs' Set up your publication steps, starting with [Name your publication](../publishing/03-name-your-publication.md). If someone else writes the newsletter, send them that link instead.

## Check it

1. The SES **Account dashboard**, in the region the app sends from, no longer says your account is in the sandbox.

1. `https://newsletter.example.com/subscribe` shows your publication's name and logo.

1. `https://newsletter.example.com/` shows your publication's name, and the post you sent yourself in [Verify it works](05-verify.md#4-send-a-real-post-to-yourself).

## What's next

Each of these guides stands on its own. Pick the ones you want.

- [Connect Claude to the API](../guides/01-connect-claude.md), so Claude can draft, proofread, and schedule posts through the same API the editor uses.
- [Notifications through Cloudflare's email](../guides/03-notifications.md), so you hear about problems even when your email provider has stopped sending.
- [As your list grows](../guides/09-as-your-list-grows.md), from about 5,000 subscribers.

When a new release comes out, [Upgrade to a new release](../guides/07-upgrade.md) shows how to move to it.
