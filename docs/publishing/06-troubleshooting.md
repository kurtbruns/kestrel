# Troubleshooting

When something needs you, Kestrel says so in a line on the send's page, under **Sent**. The top of the dashboard shows it too. Red needs you to act, and amber is worth a look. The line says what happened and what to do. This page covers what the screen can't: the fixes made outside Kestrel, and the decisions that are yours.

**Set a notifications address, so a problem reaches you without your watching.** Set it under **Settings → Notifications**, in **Send notifications to**: type an address and choose **Add inbox**. Add the address of whoever runs your instance too, and both of you are told. With none set, Kestrel emails you nothing. [Notifications](#notifications), below, lists what you're told.

| Symptom | Where the fix is |
| --- | --- |
| [A send is held or waiting](#a-send-is-held-or-waiting) | Usually outside Kestrel |
| [Someone was mailed twice, or not at all](#someone-was-mailed-twice-or-not-at-all) | In Kestrel |
| [A reader says they never got a post](#a-reader-says-they-never-got-a-post) | In Kestrel |
| [A send still reads Settling](#a-send-still-reads-settling) | Nothing to fix, unless no receipts come at all |
| [A test doesn't arrive](#a-test-doesnt-arrive) | Outside Kestrel |
| [Signups aren't open yet, or are paused](#signups-arent-open-yet-or-are-paused) | In Kestrel, or outside it |
| [The dashboard names a problem with your Amazon SES account](#a-problem-with-amazon-ses) | Outside Kestrel |
| [An address bounced or complained](#an-address-bounced-or-complained) | Nothing to fix, unless you lift a suppression |
| [A warning says to move to Workers Paid](../guides/09-as-your-list-grows.md) | Outside Kestrel |
| [An import is refused](#an-import-is-refused) | In your file |
| [Claude can't connect](#claude-cant-connect) | Usually outside Kestrel |

## A send is held or waiting

Nothing is lost. A problem with your email provider never marks anyone unsent or mails anyone twice. The send waits where it is, and carries on once the problem is fixed. The send's line names the fix. When that fix is outside Kestrel, it's one of these:

- **Amazon SES refuses your account or the send.** The line carries SES's words and the fix, almost always in the SES console. [Connect Amazon SES](../get-started/05-ses.md) sets up each piece SES checks: the sending domain, the AWS key, and the configuration set. [Request production access](../get-started/06-production-access.md) lifts the sandbox. When SES refuses your account, any other post that comes due meanwhile waits with it. When it refuses only this send's email, other posts go out as usual. While SES takes some readers and refuses the rest, as while a daily quota frees up, those it takes are sent. The line stays until SES takes everyone.
- **SES keeps refusing for its sending rate.** Kestrel is sending faster than your SES account allows. **Settings → Email sender** shows the **Send rate** and where it comes from. If `SES_MAX_SEND_RATE` sets it, lower it to the maximum send rate on the SES console's account dashboard, or remove it, then deploy, as [Configuration](../reference/01-configuration.md#vars) describes. If it's Kestrel's default, the app can't read your account: allow its key `ses:GetAccount`, as [Connect Amazon SES](../get-started/05-ses.md#5-create-the-apps-aws-key) shows.
- **No email provider is connected.** Connect one, as [Connect Amazon SES](../get-started/05-ses.md) describes, and the send goes out at its next retry.
- **A send missed its time, or nothing has gone out for a while.** The part of Kestrel that sends has stopped, or keeps failing on this send. Check the Worker's Cron Trigger, as [Configuration](../reference/01-configuration.md#bindings-and-triggers) describes, and read the app's logs, as [Read the logs](../get-started/07-verify.md#7-read-the-logs) describes. If another send is going out at the same time, this one may only be waiting its turn.

If someone else set up Kestrel for you, pass this along to them.

## Someone was mailed twice, or not at all

Kestrel never mails a reader twice on its own. When it can't tell whether your provider took some emails, it stops and asks you: the send's page shows **Resolve…**. Choose **Assume not sent** unless you know otherwise, since it's the safe default: those readers may miss this post, but get your next one. Choose **Assume sent** only when you know they got it, such as from a reader who tells you so. Either choice mails no one.

A reader recorded as **Unsent** is still on your list and gets your next post. That send never mails them again: their own email kept failing, SES won't take their address, or you chose **Assume not sent**.

## A reader says they never got a post

Under **Subscribers**, search for their address and open their row. Their page lists every send they were in, newest first, with what happened on each: **Delivered**, a bounce, a complaint, **Unsent** with your email provider's words, or **Skipped** because they had unsubscribed or were suppressed by then. Each send links to its record. The page also shows how they joined and why they left, if they did. Any bounce or block on the address shows with the provider's words or yours. If they aren't on the list, or are still **pending**, they never confirmed, and only confirmed subscribers are sent your posts.

## A send still reads Settling

That's normal. **Delivered** counts only the emails your provider confirmed reached the reader's mail server. Confirmations can lag by days, so the counts keep rising after a send finishes. Some are never confirmed at all, so a send can read **Settling** for good, as long as some receipts have come.

When none come, the send's page says so an hour after it went out. Your provider's reports aren't reaching Kestrel, so its bounces suppress no one and its complaints unsubscribe no one. Your next post mails those addresses again. Look for `webhook.refused` errors in the app's logs, as [Read the logs](../get-started/07-verify.md#7-read-the-logs) describes. Each names the SNS topic that reached Kestrel and the one it expects. Then check the subscription, as [Connect Amazon SES](../get-started/05-ses.md#7-subscribe-the-app-to-the-topic) describes. If someone else set up Kestrel for you, pass this along to them.

## A test doesn't arrive

While Amazon SES is in its sandbox, it mails only addresses verified in SES. Verify the address you test with in the SES console, or [request production access](../get-started/06-production-access.md). When the test's line says the provider didn't answer, check the inbox before you send it again, since the first may have arrived. A test SES refuses for your account has the same fix as [a send it refuses](#a-send-is-held-or-waiting). If someone else set up Kestrel for you, pass this along to them.

## Signups aren't open yet, or are paused

Your subscribe page takes signups only while email is working, so a reader is never told a link is coming when none can go. Every visitor gets the same page, whatever address they enter.

- "Signups aren’t open yet" means SES hasn't sent an email for your publication yet. Send one from **Template → Send test email**, to an address verified in SES while it's in the sandbox. Once SES takes it, signups open. Before an email provider is connected, the page says the same, and [Connect Amazon SES](../get-started/05-ses.md) is the fix.
- "Signups are paused" means SES is refusing your email, every email including confirmations and tests. The dashboard's **Email isn’t going out** line gives SES's words and the fix, as for [a problem with Amazon SES](#a-problem-with-amazon-ses). Then send a test email: once SES takes one, signups reopen.

Kestrel notices a refusal when an email meets it, or within about ten minutes from its check of your SES account. A refusal the check found lifts on its own within about ten minutes of the fix; one an email met lifts when a test email goes through. A reader who signed up just as it started may have been told a link was coming, and can sign up again once signups reopen.

If someone else set up Kestrel for you, pass this along to them.

## A problem with Amazon SES

**Settings → Email sender** and the top of the dashboard name a problem with your Amazon SES account within about ten minutes, without sending anything. Red means no email can go out until it's fixed, tests and confirmations included. Amber is worth a look. Each line links the step that fixes it:

- **The configuration set is missing, or its sending is off.** The set Kestrel sends with, the one `SES_CONFIGURATION_SET` names or the sending identity's default if that secret isn't set, isn't in your region, or its sending is turned off. Correct the name, or create the set, as [Connect Amazon SES](../get-started/05-ses.md#4-send-bounces-and-complaints-to-the-app) shows. Turn a set's sending back on in the SES console, under its configuration sets.
- **SES rejects the AWS key.** The key ID is unknown, the secret doesn't match it, or the AWS account isn't signed up for SES. Store the key's ID and secret again, or create a new key, as [Connect Amazon SES](../get-started/05-ses.md#5-create-the-apps-aws-key) shows.
- **The sender isn't verified.** SES has no verified identity for the From address in your region. Verify the sending hostname, as [Connect Amazon SES](../get-started/05-ses.md#1-verify-your-sending-hostname) shows.
- **Sending is turned off for the account.** AWS documents turning it back on only with the AWS CLI, naming your region: `aws sesv2 put-account-sending-attributes --sending-enabled --region us-east-1`.
- **AWS paused the account, or is reviewing it.** AWS does this when the account's bounce or complaint rate runs high. While it reviews, SES still sends, and the line is amber. Once it pauses sending, the line is red. Either way, AWS's email to the AWS account says what it needs: answer it in AWS Support, and check the addresses on your recent sends' records.

The app needs to read each of these. If its key isn't allowed to, the line says nothing rather than guessing. The policy in [Connect Amazon SES](../get-started/05-ses.md#5-create-the-apps-aws-key) allows all of it.

If someone else set up Kestrel for you, pass this along to them.

## An address bounced or complained

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

[Connect Claude](08-connect-claude.md) covers connecting it. Most failures are in your instance's Cloudflare Access setup, and [Allow Claude to connect](../guides/01-allow-claude.md#check-it) lists their fixes. When connecting fails:

- **Claude says it couldn't connect, or the sign-in failed.** Check that the connector's address is your publication's address followed by `/api/mcp`, and that your instance is deployed, not running on your own computer. If both are right, your instance's Access setup needs the fix.
- Signing in shows `invalid_target`, or `kestrel login` says your instance "doesn't offer a sign-in for programs". Your instance's Access setup needs the fix.
- `kestrel login` or `kestrel api` reports a `401`. Access signed you in, but Kestrel refused the sign-in, and your instance's Access setup needs the fix. If either names `access_unidentified`, it's the "Access let you in" problem below. If `kestrel api` says your sign-in has ended, sign in again as [Connect Claude](08-connect-claude.md#claude-code) describes.
- `kestrel api` says it couldn't renew your sign-in because its Access team answered 404 (not found). First check which instance it called: when you don't name one, it prints a line naming it before "the only instance you're signed in to", which may not be the one you meant. Name yours with `--url`. If it is yours, the Access team domain was most likely renamed or removed since you signed in. Sign in again with `npx kestrel login` and your instance's address, which finds the team it uses now.
- **"Access let you in, but didn't say who you are".** Your login carried neither an email nor a service token. Sign out, then sign in through the policy that lets you in by email. If you have no such policy, your instance's Access setup needs the fix.
- **Claude's changes read "via the API".** Claude called the API some way other than `kestrel api`, which names Claude Code. Your instance's instructions for Claude Code have it use `kestrel api` once they're brought up to date, as [Install the release](../guides/07-upgrade.md#2-install-the-release) describes. Changes reading "a service token" mean Claude still uses one, and [Connect Claude](08-connect-claude.md#claude-code) signs it in as you instead.

If someone else set up Kestrel for you, pass this along to them.

## Where to look

When a line doesn't settle it, these say the most about what happened:

- The top of the dashboard: what needs someone now, in Kestrel's own words.
- The send's page, under **Sent**: what happened on that send, when it next retries, and its record of each reader.
- **Settings → Email sender**: the state of your Amazon SES account, and your **Send rate**.
- **Settings → Notifications**: **Last notification** says whether the last one arrived.
- A subscriber's page, under **Subscribers**: every send they were in, and what happened on each.
- The app's logs, in your instance's Cloudflare account: [Read the logs](../get-started/07-verify.md#7-read-the-logs) describes them. If someone else set up Kestrel for you, pass this along to them.

## Notifications

With an address set, Kestrel emails you:

- when a send finishes, with how many emails your provider accepted, and how late it went out if it did
- when no one's email was accepted for a finished send, since it can't be sent again
- when email isn't going out and signups are paused: once when it starts, and once more if a post is held after an email that named none
- when your provider refuses a send or hits a limit, or no provider is connected
- when the SES sandbox refuses a signup's confirmation, at most once a day
- when a send stops going out with nothing to explain it, waits for you to resolve it, or doesn't go out on time
- when your provider has sent no receipts for six hours after a send, once until a receipt arrives

Each says whether anyone has to act, and how. If the fix needs whoever set up your instance, you can forward it as it stands. Each goes to every address set, links to the page it's about, and is sent once while the problem lasts. A reader's address in your provider's words shows only as its domain, and in full on the send's page. If one address can't be reached, the others still get it, and **Last notification** names the one that failed. A bounce spike shows on the dashboard but isn't emailed. **Send a test notification** checks that one arrives.

By default, notifications go through your newsletter's own email provider. So when that provider refuses your account, the notification about it can't reach you either. You can send them another way, as [Notifications through Cloudflare's email](../guides/03-notifications.md) describes.
