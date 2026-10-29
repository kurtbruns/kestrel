# Go live

At this point, your instance should be deployed and verified. Before anyone subscribes, check that AWS granted production access, as [Check that AWS granted it](06-production-access.md#4-check-that-aws-granted-it) describes, so SES can send to anyone. From here, the publisher can set up the publication, and you can continue with the guides below.

## Start publishing

The rest happens in the editor, at `https://newsletter.example.com/dashboard/`. The Publishing docs walk through it in the order of the dashboard's setup checklist, starting with [Name your publication](../publishing/03-name-your-publication.md).

If someone else is the publisher, [Setting it up for someone else](#setting-it-up-for-someone-else) says when and how to let them in.

## Setting it up for someone else

If you're setting up the instance for someone else, such as a client, hand it over right after the production access request goes in. By then, everything that needs AWS or Cloudflare is done, and AWS's review gives the publisher time to write.

### Before the hand-off

1. Name and brand the publication, as in [Name the publication](06-production-access.md#1-name-the-publication), with the publisher's name, tagline, and logo. AWS's reviewer may visit the home page, so it should say what the newsletter is.

1. Under **Settings → Notifications**, set **Send notifications to** so problems reach both of you, such as an address you both read. While SES is in the sandbox, it sends only to verified addresses, so verify any address that's new, as in [Verify your test addresses](05-ses.md#3-verify-your-test-addresses).

1. Send yourself a test email, as in [Send yourself a test email](07-verify.md#1-send-yourself-a-test-email), so you know SES sends before anyone else relies on it.

1. Request production access, as in [Request production access](06-production-access.md).

The rest of [Verify it works](07-verify.md) can run during AWS's review. Its test post and subscribers show in the editor until you clean them up, so finish it first, or tell the publisher they're yours.

### Let the publisher in

1. Add their email address to the policy on the Access application that lets you in, as in [Allow yourself in](03-access.md#3-allow-yourself-in). If you set `ACCESS_ALLOWED_EMAILS`, store the list again with their address added, as in [Give the app its two values](03-access.md#4-give-the-app-its-two-values).

1. If they don't have a Cloudflare account, add another way to sign in, such as a one-time code by email. It's under **Zero Trust → Integrations → Identity providers**.

1. Send them the dashboard's address, `https://newsletter.example.com/dashboard/`, and a link to [Name your publication](../publishing/03-name-your-publication.md).

### After the hand-off

AWS writes to the AWS account's email address, which is yours, so answering AWS stays with you. If it asks for more, reply in the support case, as in [Answer AWS's questions](06-production-access.md#3-answer-awss-questions). When it grants access, check it as in [Check that AWS granted it](06-production-access.md#4-check-that-aws-granted-it), and tell the publisher they can share the subscribe link. Until then, confirmation emails reach only verified addresses.

## Optional next steps

Each of these guides adds one thing, and you can come back to any of them later.

- [Allow Claude to connect](../guides/01-allow-claude.md), so the publisher can connect Claude Desktop, claude.ai, or Claude Code, and have it draft, proofread, and schedule posts as them, through the same API the editor uses.
- [Automate with a service token](../guides/02-automate.md), so a script can call the API with a service token, when no one is signed in.
- [Notifications through Cloudflare's email](../guides/03-notifications.md), so problems are reported even when the email provider has stopped sending.
- [Rate-limit the subscribe form](../guides/05-rate-limit.md), before the subscribe link is shared widely.
- [As your list grows](../guides/09-as-your-list-grows.md), from about 1,000 subscribers.
- [Upgrade to a new release](../guides/07-upgrade.md), when one comes out.
