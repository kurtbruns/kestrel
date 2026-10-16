# Troubleshooting

When a send needs you, its page and the dashboard's health block say so in a red or amber line. Red needs you to act, and amber is worth a look. Find the line's words below for what it means and what to do.

**Set a notifications address, so a problem reaches you without your watching.** Set it under **Settings → Notifications**, in **Send notifications to**. With none set, Kestrel emails you nothing. [Notifications](06-troubleshooting.md#notifications), below, lists what you're told.

## A send is waiting or held

A problem with your email provider never marks anyone unsent. The send waits where it is, and carries on from there once the problem clears. "No one has been marked unsent because of this" means this problem: readers whose own email failed earlier stay unsent.

- **"The provider is refusing the account".** Your provider won't take mail from your account, and its own words follow, with the fix and who makes it. The fix is almost always in your Amazon SES account or Kestrel's deployment, made by whoever runs it. [What SES refuses, and the fix](#what-ses-refuses-and-the-fix), below, lists each one. Any other post that comes due meanwhile waits with it, without asking SES, and you're told once. While a quota frees up a few at a time, or while the SES sandbox takes only your verified addresses, SES takes some readers on each retry and refuses the rest: those it takes are sent, and the line stays, with the time it began, until SES takes everyone it's asked to.
- **"The provider is refusing this send".** SES refuses this post's email itself, or a batch of it as invalid, rather than your account. Its words follow. Other posts go out as usual. If SES's words name a reader's address, remove that subscriber: the send skips them and carries on at its next retry. If SES refuses the email itself, the email can't change once its send has started, so whoever runs the deployment asks AWS Support why, quoting SES's words.
- **"No email provider is connected".** The send is held until one is connected ([Connect Amazon SES](../get-started/04-ses.md)), and goes out once it is.
- **"The provider is unavailable".** An outage or a rate limit on the provider's side. The send reads **Backing off** and says when it next retries, spacing its retries out up to an hour apart while the outage lasts, so there's nothing to do. Any other post that comes due meanwhile waits with it.
- **"The provider keeps refusing for its sending rate".** An amber line. SES has refused the first request of several retries in a row for its sending rate, which a short burst never does, so Kestrel is set to send faster than your SES account allows. Whoever runs the deployment sets `SES_MAX_SEND_RATE` to the **Maximum send rate** on the SES console's **Account dashboard** (1 a second in the sandbox), and deploys, as [Connect Amazon SES](../get-started/04-ses.md#8-set-the-provider-and-deploy) describes. The send retries on its own meanwhile.
- **"Nothing has gone out for …".** A send has handed off no one for half an hour, with no retry or provider problem to explain it. The part of Kestrel that sends has stopped or keeps failing on this send, or another send going out at the same time is taking all of its turn. A large send going out slowly never shows this. If another send is going out, this one picks up once it finishes. Read the app's logs, as [Read the logs](../get-started/05-verify.md#7-read-the-logs) describes, and check the Worker's trigger, as [`triggers.crons`](../reference/01-configuration.md#triggerscrons) describes. The send carries on from where it stopped once it runs again, mailing no one twice.
- **"The fire time passed … and the send has not started".** The Cloudflare Cron Trigger that starts sends on time isn't running. The send goes out as soon as it runs again. Check the Worker's trigger, as [`triggers.crons`](../reference/01-configuration.md#triggerscrons) describes.
- **"The provider never answered for …".** Rarely, Kestrel can't tell whether your provider took some emails, and sending again could mail those readers twice. **Resolve…** on the send's page asks you to decide. **Assume not sent** is the safe default: those readers may miss this post, but get your next one. Choose **Assume sent** only when you know they got it.

## Before a send

- **A test says "The provider refused it".** Your provider didn't take the test, and its own words follow, with the fix where Kestrel knows it. Sending again gets the same answer until that's fixed. While Amazon SES is in its sandbox, it sends only to addresses verified in SES, so verify the address you test with in the SES console, or request production access, as [Connect Amazon SES](../get-started/04-ses.md#5-request-production-access) describes. Words about the account, such as a key or the sending domain, point at the same fix as [a send the provider refuses](06-troubleshooting.md#a-send-is-waiting-or-held).
- **A test says "The provider didn't answer, so the test may have arrived".** Kestrel can't tell whether your provider took it. Check the inbox before you send again, since a second test may arrive twice.
- **"The template or publication details changed this email's look after your last test".** Send a new test of the post, since your last one no longer shows what goes out.
- **The daily database writes warning.** On Cloudflare's free Workers plan, a large send may use up the day's writes, and then the app stops working until midnight UTC. [Bring your existing list](01-your-list.md#limits) explains the limit, and when to upgrade to Workers Paid.

## Reading a send's record

A send's page becomes its permanent record once it finishes. Its counts cover everyone the send went to:

| Count | What it means |
| --- | --- |
| **Delivered** | Your provider confirmed the email reached the reader's mail server. |
| **Bounced** | The receiving server turned the email away. |
| **Complained** | The reader marked the email as spam. |
| **Unsent** | Kestrel couldn't hand the email to your provider. |

Delivered always means confirmed, not just accepted by your provider. Confirmations can lag by days, so counts keep rising after a send finishes. Some emails are never confirmed at all, so a send can read **Settling** for good, which is normal, as long as some receipts have come.

**"No delivery receipt has arrived for any of …".** An hour after a send went out, Kestrel has heard back about none of its readers. Your provider's reports probably aren't reaching Kestrel, so its bounces and complaints suppress no one, and your next post mails those addresses again. Look for `webhook.refused` errors in the app's logs, as [Read the logs](../get-started/05-verify.md#7-read-the-logs) describes. It names the SNS topic that reached Kestrel and the one it expects. Then check the subscription in [Connect Amazon SES](../get-started/04-ses.md#9-subscribe-the-app-to-the-topic). The line goes as soon as a receipt arrives.

**Unsent recipients** are still on your list, and get your next post. A recipient is unsent when their own email kept failing, or their address isn't one SES accepts, with the provider's words on the row, or when you chose **Assume not sent**.

### What SES refuses, and the fix

When SES refuses your account or a send, the red line carries SES's words and the fix. Almost every fix is made by whoever runs the deployment, in the SES console or the deployment's settings.

| SES says | What it means | The fix |
| --- | --- | --- |
| Email address is not verified, naming a reader | The SES account is still in the sandbox, which mails only verified addresses. | Request production access on the SES console's **Account dashboard**, as [Connect Amazon SES](../get-started/04-ses.md#5-request-production-access) describes. Signups fail until then, and you're emailed about it once a day. |
| Email address is not verified, naming your From address or its domain | The sending identity isn't verified in this SES region. | Verify the From address or its domain in SES, in the region the deployment sends from. |
| Mail FROM domain is not verified | SES can't read the custom MAIL FROM domain's MX record. | Check that record in DNS, or set the identity's **Behavior on MX failure** to use the default MAIL FROM domain. |
| Daily message quota exceeded | The 24-hour sending quota is spent. It frees up on its own. | In the sandbox (200 a day), request production access. Otherwise, ask AWS for a higher quota, as [As your list grows](../guides/09-as-your-list-grows.md) describes. |
| Sending paused (account) | AWS paused the account under review, or sending was turned off by hand. | Follow AWS's email to the AWS account's address, or turn sending back on. |
| Sending paused (configuration set) | Sending is turned off on the configuration set, by hand or by an alarm. | Turn sending back on for that set. |
| Account suspended | AWS shut down the account's sending. | Only AWS can lift it: open a case with AWS Support. |
| An access key, signature, or permission error | The deployment's SES key is wrong, expired, or lacks permission. | Replace the key, or give it `ses:SendEmail` and `ses:SendBulkEmail`. |
| A subscription is needed (OptInRequired) | The AWS account isn't signed up for SES. | Enable SES for the account, or settle its activation or billing with AWS. |
| Configuration set does not exist | `SES_CONFIGURATION_SET` names a set that isn't in this region. | Fix the name, or create the set. |
| Sending pool not found | The configuration set uses a dedicated IP pool that doesn't exist. | Pick an existing pool in the set's sending options, or remove it. |
| The message was rejected | SES refuses this email itself. | Ask AWS Support why. Other posts go out as usual. |
| The request is invalid | SES refused a batch of this send. | If SES's words name a reader's address, remove that subscriber. |

A server error from SES may come after SES already took the emails, so Kestrel never sends that batch again: its readers wait for **Resolve…**, as for "The provider never answered for …".

## Bounces and complaints

Kestrel acts on these for you, so a bad address can't keep hurting your sending reputation:

- **A hard bounce** means the address can't receive mail. Kestrel never mails it again.
- **A soft bounce** is temporary, such as a full mailbox. The address stays on your list.
- **A complaint** means the reader marked your email as spam. Kestrel never mails them again.

Under **Subscribers**, a suppressed address keeps its status and carries a label saying why. When a recent send's bounces reach about 5% of its recipients, the dashboard warns you. That's about the rate at which email providers start to review a sender, so check the addresses on its record.

### Lifting a suppression

Lift one only when you know the address works again, such as a reader who tells you their mailbox is fixed. Mailing an address that keeps failing can hurt every send after it. A complaint is different: the reader marked your mail as spam, so lift it only when they ask you for your posts again. Providers allow far fewer complaints than bounces. In a subscriber's ⋯ menu, **Unblock** lifts a block and **Clear** lifts a bounce or a complaint, after asking you to confirm. Past records keep the bounce or complaint where it happened.

## An import is refused

Kestrel refuses a file it can't read with certainty, and says what's wrong and where. Nothing on your list changes.

- **Not in the format.** The file isn't a Kestrel CSV or a plain list. Convert it first, with Claude or by hand.
- **A column or value the format doesn't take,** named with its row and column. Fix it in the file, or move a column of your old service's into `evidence`.
- **Too many rows** for one import. Split the file.
- **Too large.** An import takes up to 10 MB.

[The file format](01-your-list.md#the-file-format) describes what each column takes.

## Notifications

With an address set, Kestrel emails you:

- when a send finishes, with how many emails were accepted, unsent, and skipped
- when your provider refuses your account or a send, or no provider is connected
- when the SES sandbox refuses a signup's confirmation, at most once a day
- when a send stops going out with nothing to explain it, waits for you to resolve it, or misses its time
- when Claude imports a list for you

Each links to the page it's about, and is sent once while the problem lasts. A bounce spike shows on the dashboard but isn't emailed. **Send a test notification** checks that one arrives.

By default, notifications go through your newsletter's own email provider. So when that provider refuses your account, the notification about it can't reach you either. You can send them another way, as [Notifications through Cloudflare's email](../guides/03-notifications.md) describes.
