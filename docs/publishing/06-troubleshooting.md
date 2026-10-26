# Troubleshooting

When something needs you, Kestrel says so in a line on the send's page, under **Sent**. The top of the dashboard shows it too. Red needs you to act, and amber is worth a look. The line says what happened, what to do, and who does it. This page covers what the screen can't: the fixes made outside Kestrel, and the decisions that are yours.

**Set a notifications address, so a problem reaches you without your watching.** Set it under **Settings → Notifications**, in **Send notifications to**. With none set, Kestrel emails you nothing. [Notifications](06-troubleshooting.md#notifications), below, lists what you're told.

## A send is held or waiting

Nothing is lost. A problem with your email provider never marks anyone unsent or mails anyone twice. The send waits where it is, and carries on once the problem is fixed. The send's line names the fix. When that fix is outside Kestrel, whoever runs your instance makes it, and it's one of these:

- **Amazon SES refuses your account or the send.** The line carries SES's words and the fix, almost always in the SES console. [Connect Amazon SES](../get-started/04-ses.md) sets up each piece SES checks: the sending domain, the AWS key, and the configuration set. Production access is in [Verify it works](../get-started/05-verify.md#3-request-production-access). When SES refuses your account, any other post that comes due meanwhile waits with it. When it refuses only this send's email, other posts go out as usual. While SES takes some readers and refuses the rest, as while a daily quota frees up, those it takes are sent. The line stays until SES takes everyone.
- **SES keeps refusing for its sending rate.** Kestrel is set to send faster than your SES account allows. Set `SES_MAX_SEND_RATE` to the maximum send rate on the SES console's account dashboard, which is 1 a second in the sandbox. Then deploy, as [Connect Amazon SES](../get-started/04-ses.md#6-set-the-provider-and-deploy) describes.
- **No email provider is connected.** Connect one, as [Connect Amazon SES](../get-started/04-ses.md) describes, and the send goes out at its next retry.
- **A send missed its time, or nothing has gone out for a while.** The part of Kestrel that sends has stopped, or keeps failing on this send. Check the Worker's Cron Trigger, as [Configuration](../reference/01-configuration.md#bindings-and-triggers) describes, and read the app's logs, as [Read the logs](../get-started/05-verify.md#8-read-the-logs) describes. If another send is going out at the same time, this one may only be waiting its turn.

## Someone was mailed twice, or not at all

Kestrel never mails a reader twice on its own. When it can't tell whether your provider took some emails, it stops and asks you: the send's page shows **Resolve…**. Choose **Assume not sent** unless you know otherwise, since it's the safe default: those readers may miss this post, but get your next one. Choose **Assume sent** only when you know they got it, such as from a reader who tells you so. Either choice mails no one.

A reader recorded as **Unsent** is still on your list and gets your next post. That send never mails them again: their own email kept failing, SES won't take their address, or you chose **Assume not sent**.

## A reader says they never got a post

Under **Subscribers**, search for their address and open their row. Their page lists every send they were in, newest first, with what happened on each: **Delivered**, a bounce, a complaint, **Unsent** with your email provider's words, or **Skipped** because they had unsubscribed or were suppressed by then. Each send links to its record. The page also shows how they joined and why they left, if they did. Any bounce or block on the address shows with the provider's words or yours. If they aren't on the list, or are still **pending**, they never confirmed, and only confirmed subscribers are sent your posts.

## A send still reads Settling

That's normal. **Delivered** counts only the emails your provider confirmed reached the reader's mail server. Confirmations can lag by days, so the counts keep rising after a send finishes. Some are never confirmed at all, so a send can read **Settling** for good, as long as some receipts have come.

When none come, the send's page says so an hour after it went out. Your provider's reports aren't reaching Kestrel, so its bounces suppress no one and its complaints unsubscribe no one. Your next post mails those addresses again. Look for `webhook.refused` errors in the app's logs, as [Read the logs](../get-started/05-verify.md#8-read-the-logs) describes. Each names the SNS topic that reached Kestrel and the one it expects. Then check the subscription, as [Connect Amazon SES](../get-started/04-ses.md#7-subscribe-the-app-to-the-topic) describes.

## A test doesn't arrive

While Amazon SES is in its sandbox, it mails only addresses verified in SES. Verify the address you test with in the SES console, or request production access, as [Verify it works](../get-started/05-verify.md#3-request-production-access) describes. When the test's line says the provider didn't answer, check the inbox before you send it again, since the first may have arrived. A test SES refuses for your account has the same fix as [a send it refuses](06-troubleshooting.md#a-send-is-held-or-waiting).

## Your list outgrows Workers Free

Upgrade the Cloudflare account to Workers Paid, and set `SUBREQUEST_BUDGET` so Kestrel sends faster, as [As your list grows](../guides/09-as-your-list-grows.md) describes. Kestrel warns you before a send that could use up the free plan's daily database writes, which stops the app until midnight UTC. [Bring your existing list](01-your-list.md#limits) explains the limits.

## Bounces and complaints

Kestrel acts on these for you, so a bad address can't keep hurting your sending reputation:

- A hard bounce means the address can't receive mail. Kestrel never mails it again.
- A soft bounce is temporary, such as a full mailbox. The address stays on your list.
- A complaint means the reader marked your email as spam. Kestrel unsubscribes them, whichever email they reported, and their page, opened from their row, says they left by a complaint.

Under **Subscribers**, a bounced address keeps its status and carries a label saying why. Its page gives your email provider's words for the bounce and when it happened. When a recent send's bounces reach about 5% of its recipients, the dashboard warns you. That's about the rate at which email providers start to review a sender, so check the addresses on its record.

### Lifting a suppression

Lift one only when you know the address works again, such as a reader who tells you their mailbox is fixed. Mailing an address that keeps failing can hurt every send after it. In a subscriber's ⋯ menu, **Unblock** lifts a block and **Clear** lifts a bounce, after asking you to confirm. A complaint isn't a suppression but the reader leaving, so nothing lifts it. They come back only by subscribing again themselves, and **Add subscriber** refuses them. Past records keep the bounce or complaint where it happened.

## An import is refused

Nothing on your list changes. Kestrel refuses a file it can't read with certainty, and names the row and column it couldn't. Fix the file and import it again. Convert a file in another format first, with Claude or by hand. Move a column of your old service's into `evidence`. Split a file of more than 10 MB, or with too many rows. [The file format](01-your-list.md#the-file-format) describes what each column takes.

## Claude can't connect

Most failures are in your instance's Cloudflare Access setup, made by whoever runs your instance. [Connect Claude](08-connect-claude.md) covers connecting it. When that fails:

- **Claude says it couldn't connect, or the sign-in failed.** Your instance's Access application needs Managed OAuth set up as [Turn on Managed OAuth](../guides/01-allow-claude.md#1-turn-on-managed-oauth) describes, including Claude's sign-in address for Claude Desktop and claude.ai. Check that the connector's address is your publication's address followed by `/api/mcp`, and that your instance is deployed, not running on your own computer.
- `kestrel login` says your instance "doesn't offer a sign-in for programs". Managed OAuth is off. Turn it on, as the same section describes.
- `kestrel login` or `kestrel api` reports a `401`. Access signed you in, but Kestrel refused the sign-in. If you set `ACCESS_ALLOWED_EMAILS`, check that it includes the address you signed in with. If either names `access_unidentified`, it's the next problem. If `kestrel api` says your sign-in has ended, sign in again as [Connect Claude](08-connect-claude.md#claude-code) describes.
- **"Access let you in, but didn't say who you are".** Your login carried neither an email nor a service token. Some other kind of Access policy let it through, such as a certificate or device rule, or a login method that gives no email. Kestrel accepts only an Allow policy on people's emails and a Service Auth policy on a service token. Sign out, then sign in through the policy that lets you in by email. Whoever runs your instance removes the other policy from its Access application, or changes it to one of those two kinds. A script that gets this needs a service token under a Service Auth policy, as [Allow the token in](../guides/02-automate.md#2-allow-the-token-in) describes.
- **Claude's changes read "via the API".** Claude called the API some way other than `kestrel api`, which names Claude Code. Your instance's instructions for Claude Code have it use `kestrel api` once they're brought up to date, as [Install the release](../guides/07-upgrade.md#2-install-the-release) describes. Changes reading "a service token" mean Claude still uses one, and [Connect Claude](08-connect-claude.md#claude-code) signs it in as you instead.

## Cloudflare won't save the Access application

Whoever sets up your instance can meet this in [Lock the dashboard with Access](../get-started/03-access.md#2-create-the-access-application). Saving the application fails with an error naming `use_clientless_isolation_app_launcher_url`, saying it needs private destinations. The form has an empty private hostname or IP row beside the two public hostnames. Remove that row, and save again.

## Notifications

With an address set, Kestrel emails you:

- when a send finishes, with how many emails were accepted, unsent, and skipped
- when your provider refuses your account or a send, or no provider is connected
- when the SES sandbox refuses a signup's confirmation, at most once a day
- when a send stops going out with nothing to explain it, waits for you to resolve it, or misses its time
- when a service token imports a list, since no one saw it happen (an import you make yourself, or through Claude, sends nothing)

Each links to the page it's about, and is sent once while the problem lasts. A bounce spike shows on the dashboard but isn't emailed. **Send a test notification** checks that one arrives.

By default, notifications go through your newsletter's own email provider. So when that provider refuses your account, the notification about it can't reach you either. You can send them another way, as [Notifications through Cloudflare's email](../guides/03-notifications.md) describes.
