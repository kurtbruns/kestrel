# Self-hosting Kestrel

These pages cover deploying and running your own Kestrel, from an empty repository to a live newsletter on your Cloudflare account. Writing and sending the newsletter is covered in [Publishing](publishing/README.md). These pages call whoever writes and sends it the publisher, which may be you.

## Get started

These are the steps to deploy a Kestrel instance and get it ready to send. Each one ends with a check, so you know it worked before you move on.

1. [Deploy the app](get-started/02-deploy.md)
1. [Lock the dashboard with Access](get-started/03-access.md)
1. [Connect Amazon SES](get-started/04-ses.md)
1. [Verify it works](get-started/05-verify.md)
1. [Go live](get-started/06-go-live.md)

## Guides

Each one stands on its own. Pick the ones you need.

- [Allow Claude to connect](guides/01-allow-claude.md)
- [Automate with a service token](guides/02-automate.md)
- [Notifications through Cloudflare's email](guides/03-notifications.md)
- [Rate-limit the subscribe form](guides/05-rate-limit.md)
- [As your list grows](guides/09-as-your-list-grows.md)
- [Upgrade to a new release](guides/07-upgrade.md)

## Reference

The detail behind the steps, for when you need it.

- [Configuration](reference/01-configuration.md)
- [Sending-domain DNS: SPF, DKIM, and DMARC](reference/02-sending-domain-dns.md)
