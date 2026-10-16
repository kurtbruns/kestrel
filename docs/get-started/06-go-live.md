# Go live

At this point, your instance should be deployed, verified, and out of the SES sandbox, so it can send to anyone. From here, the publisher can set up the publication, and you can continue with the guides below.

## Start publishing

The rest happens in the editor, at `https://newsletter.example.com/dashboard/`. The Publishing docs walk through it in the order of the dashboard's setup checklist, starting with [Name your publication](../publishing/03-name-your-publication.md).

If someone else is the publisher, let them sign in first:

1. Add their email address to the `Publishers` policy on the Access application, as in [Allow yourself in](03-access.md#3-allow-yourself-in). If you set `ACCESS_ALLOWED_EMAILS`, store the list again with their address added.

1. If they don't have a Cloudflare account, add another way to sign in, such as a one-time code by email. It's under **Zero Trust → Integrations → Identity providers**.

1. Send them the editor's address and a link to [Name your publication](../publishing/03-name-your-publication.md).

## Optional next steps

Each of these guides adds one thing, and you can come back to any of them later.

- [Connect Claude to the API](../guides/01-connect-claude.md), so Claude can draft, proofread, and schedule posts through the same API the editor uses.
- [Notifications through Cloudflare's email](../guides/03-notifications.md), so problems are reported even when the email provider has stopped sending.
- [Rate-limit the subscribe form](../guides/05-rate-limit.md), before the subscribe link is shared widely.
- [As your list grows](../guides/09-as-your-list-grows.md), from about 1,000 subscribers.
- [Upgrade to a new release](../guides/07-upgrade.md), when one comes out.
