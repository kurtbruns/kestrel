# Go live

At this point, your instance should be deployed and verified. Before anyone subscribes, [check that AWS granted production access](06-production-access.md#4-check-that-aws-granted-it), so SES can send to anyone. From here, where you go next depends on who's writing the newsletter.

## Start publishing

Open the editor at `https://newsletter.example.com/dashboard/`. The dashboard's setup steps show what's left, and [Publishing](../publishing/README.md) covers each one.

## Hand off to someone else

[Let them into the editor](03-access.md#allow-someone-else-in), and add their address beside yours under **Settings → Notifications**, so a problem reaches both of you. Then send them the editor's address and a link to [Publishing](../publishing/README.md). The dashboard's setup steps show them what's left.

## What reaches you, and how

Three kinds of email tell you about the instance, each by its own route:

- Kestrel's notifications, through SES, from the publication's name followed by `via Kestrel`, to the addresses under **Settings → Notifications**. They cover each send and each problem a send runs into. They can't arrive while SES refuses the account.
- Cloudflare's alerts, from the two Monitors you created in [Verify it works](07-verify.md#8-create-the-cloudflare-alerts), from `noreply@notify.cloudflare.com`. They cover SES refusing the account, and Kestrel itself stopping.
- AWS's own notices, to the email address of the AWS account, about the account itself, such as a review of your sending or a bill. Kestrel never sees them, so make sure that address is one someone reads.

## Optional guides

Each one adds one thing, and you can come back to any of them later.

- Before you share your subscribe link: [Rate-limit the subscribe form](../guides/05-rate-limit.md)
- To have Claude draft, proofread, and schedule posts: [Allow Claude to connect](../guides/01-allow-claude.md)
- To run scripts with no one signed in: [Automate with a service token](../guides/02-automate.md)
- To see when your list needs Workers Paid or higher SES limits: [As your list grows](../guides/09-as-your-list-grows.md)
- To move to a new release: [Upgrade to a new release](../guides/07-upgrade.md)
