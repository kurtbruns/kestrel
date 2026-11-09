# Self-hosting Kestrel

These pages cover deploying and running your own Kestrel, from an empty repository to a live newsletter on your Cloudflare account. Writing and sending the newsletter is covered in [Publishing](publishing/README.md). These pages call whoever writes and sends it the publisher, which may be you.

## Get started

These are the steps to deploy a Kestrel instance and get it ready to send. Each one ends with a check, so you know it worked before you move on.

1. [Deploy the app](get-started/deploy.md)
1. [Lock the dashboard with Access](get-started/access.md)
1. [Create an AWS account](get-started/aws-account.md)
1. [Connect Amazon SES](get-started/ses.md)
1. [Request production access](get-started/production-access.md)
1. [Verify it works](get-started/verify.md)
1. [Go live](get-started/go-live.md)

## Guides

Each one stands on its own. Pick the ones you need.

- [Allow Claude to connect](guides/allow-claude.md)
- [Set up alerts](guides/alerts.md)
- [Rate-limit the subscribe form](guides/rate-limit.md)
- [Upgrade to a new release](guides/upgrade.md)
- [As your list grows](guides/as-your-list-grows.md)
- [Automate with a service token](guides/automate.md)

## Reference

The detail behind the steps, for when you need it.

- [Configuration](reference/configuration.md)
- [Sending-domain DNS: SPF, DKIM, and DMARC](reference/sending-domain-dns.md)
