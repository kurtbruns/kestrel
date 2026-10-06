# Overview

Kestrel is a newsletter app you run yourself. You write a post in Markdown, preview it exactly as the email, and send it to a list you own. It runs on Cloudflare Workers, and an email provider delivers the mail.

In this guide, you deploy your own instance of Kestrel to your Cloudflare account and connect it to an email provider. You go from a fresh clone of the repository to a newsletter that's ready for its first subscriber. Each step ends with a check, so you know it worked before you move on.

You run every step from your own copy of the repository. It holds your instance's configuration, and you return to it to deploy changes and upgrade to new releases. You don't need to run Kestrel on your computer to deploy it, but you can: the [README](https://github.com/kurtbruns/kestrel#local-setup) covers running it locally with demo content.

## Before you begin

You need:

1. A [Cloudflare account](https://dash.cloudflare.com/sign-up), with your domain's DNS on Cloudflare. Your app's hostname and its login both live there.

1. An account with an email provider: [Resend](https://resend.com/signup) or [Amazon SES](https://aws.amazon.com/ses/). These guides use Resend. To use SES, follow [Use Amazon SES instead of Resend](../guides/02-ses.md) in place of step 4.

1. [Node.js](https://nodejs.org/) 22 or later, and [Git](https://git-scm.com/).

1. A GitHub account, or another Git host, for your own copy of the repository.

## Choose your hostnames

Kestrel uses two hostnames, because the app and the mail do different jobs:

| Hostname | What it's for |
| --- | --- |
| `newsletter.example.com` | the editor, the API, and the public pages readers see |
| `send.example.com` | the address your mail comes from, and its SPF, DKIM, and DMARC records |

These guides put the app on a subdomain, which leaves any website you already have on `example.com` untouched. If `example.com` has no website of its own, the app can live there instead. Use `example.com` wherever these guides say `newsletter.example.com`.

It's recommended to send from a subdomain rather than from `example.com` itself. Your apex domain carries the reputation of your regular email, and a newsletter shouldn't put that at risk. Avoid `mail.` as the sending name too, since mail servers read it as an inbound host. [Sending-domain DNS](../reference/02-sending-domain-dns.md#two-hard-rules) explains both.

Throughout these guides, replace `example.com`, `newsletter.example.com`, and `send.example.com` with your own names. Replace any value written as `REPLACE_WITH_…` too.

## The steps

1. **Overview**: what you need, and the hostnames you use.
1. [Deploy the app](02-deploy.md): get your own copy of the repository, and put the app on your hostname.
1. [Lock the dashboard with Access](03-access.md): add the login that keeps the editor and the API to you.
1. [Connect Resend](04-resend.md): verify your sending domain, and connect Resend to the app.
1. [Verify it works](05-verify.md): send real email to yourself, and test unsubscribing and bounces.
1. [Go live](06-go-live.md): name your publication and share the subscribe link.

Further guides, like [connecting Claude](../guides/01-connect-claude.md) and [upgrading to a new release](../guides/07-upgrade.md), pick up from there.

When you're ready, continue to [Deploy the app](02-deploy.md).
