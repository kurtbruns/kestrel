# Troubleshooting

When a send needs you, its page and the dashboard's health block say so in a red or amber line. Red needs you to act, and amber is worth a look. Find the line's words below for what it means and what to do.

**Set a notifications address, so a problem reaches you without your watching.** Set it under **Settings → Notifications**, in **Send notifications to**. With none set, Kestrel emails you nothing. [Notifications](06-troubleshooting.md#notifications), below, lists what you're told.

## A send is waiting or held

A problem with your email provider never marks anyone unsent. The send waits where it is, and carries on from there once the problem clears.

- **"The provider is refusing the account".** Your provider won't take mail from your account, and its own words follow, with the fix they point to. The fix is almost always in your Amazon SES account or Kestrel's deployment, and the message names it. A spent daily sending quota frees up within a day, and you can ask AWS for a higher one, as [As your list grows](../guides/09-as-your-list-grows.md) describes. While the quota frees up a few at a time, SES takes a few readers on each retry and refuses the rest: those it takes are sent, and the line stays, with the time it began, until SES takes everyone it's asked to.
- **"No email provider is connected".** The send is held until one is connected ([Connect Amazon SES](../get-started/04-ses.md)), and goes out once it is.
- **"The provider is unavailable".** An outage or a rate limit on the provider's side. The send reads **Backing off** and says when it next retries, spacing its retries out up to an hour apart while the outage lasts, so there's nothing to do.
- **"Nothing has gone out for …".** A send has handed off no one for half an hour, with no retry or provider problem to explain it. The part of Kestrel that sends has stopped or keeps failing on this send, or another send going out at the same time is taking all of its turn. A large send going out slowly never shows this. If another send is going out, this one picks up once it finishes. Read the app's logs, as [Read the logs](../get-started/05-verify.md#7-read-the-logs) describes, and check the Worker's trigger, as [`triggers.crons`](../reference/01-configuration.md#triggerscrons) describes. The send carries on from where it stopped once it runs again, mailing no one twice.
- **"The fire time passed … and the send has not started".** The Cloudflare Cron Trigger that starts sends on time isn't running. The send goes out as soon as it runs again. Check the Worker's trigger, as [`triggers.crons`](../reference/01-configuration.md#triggerscrons) describes.
- **"The provider never answered for …".** Rarely, Kestrel can't tell whether your provider took some emails, and sending again could mail those readers twice. **Resolve…** on the send's page asks you to decide. **Assume not sent** is the safe default: those readers may miss this post, but get your next one. Choose **Assume sent** only when you know they got it.

## Before a send

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

Delivered always means confirmed, not just accepted by your provider. Confirmations can lag by days, so counts keep rising after a send finishes. Some emails are never confirmed at all, so a send can read **Settling** for good, which is normal.

**Unsent recipients** are still on your list, and get your next post. A recipient is unsent when their own email kept failing, with the provider's words on the row, or when you chose **Assume not sent**.

## Bounces and complaints

Kestrel acts on these for you, so a bad address can't keep hurting your sending reputation:

- **A hard bounce** means the address can't receive mail. Kestrel never mails it again.
- **A soft bounce** is temporary, such as a full mailbox. The address stays on your list.
- **A complaint** means the reader marked your email as spam. Kestrel never mails them again.

Under **Subscribers**, a suppressed address keeps its status and carries a label saying why. When a recent send's bounces reach about 5% of its recipients, the dashboard warns you. That's about the rate at which email providers start to review a sender, so check the addresses on its record.

### Lifting a suppression

Lift one only when you know the address works again, such as a reader who tells you their mailbox is fixed. Mailing an address that keeps failing can hurt every send after it. **Unblock**, in a subscriber's ⋯ menu, lifts a block. The dashboard can't lift a bounce or a complaint, but [Claude](07-working-with-claude.md) can, when you ask. Past records keep the bounce or complaint where it happened.

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
- when your provider refuses your account, or no provider is connected
- when a send stops going out with nothing to explain it, waits for you to resolve it, or misses its time
- when Claude imports a list for you

Each links to the page it's about, and is sent once while the problem lasts. A bounce spike shows on the dashboard but isn't emailed. **Send a test notification** checks that one arrives.

By default, notifications go through your newsletter's own email provider. So when that provider refuses your account, the notification about it can't reach you either. You can send them another way, as [Notifications through Cloudflare's email](../guides/03-notifications.md) describes.
