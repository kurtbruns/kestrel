# After a send

Once a send starts, Kestrel keeps a permanent record of it: who it went to, and what happened to each email. The post goes up on its public page in your archive at the same moment, exactly as it was sent. Nothing about either can be edited, and you don't have to watch: Kestrel emails you when the send finishes, and when something needs you.

This page covers a send's record, unsent recipients, bounces and complaints, your notifications, the dashboard's views, and the post's public page.

## The send's record

Every send has its own page, which you open from **Sent** or from the dashboard's **Sent** list. While the send goes out, the page is a live view of its progress. Once it finishes, the same page becomes its record, in place.

The record opens with five counts, over everyone the send went to:

| Count | What it means |
| --- | --- |
| **Recipients** | Everyone the send went to: your confirmed subscribers who weren't suppressed when it started. |
| **Delivered** | Emails your provider confirmed reached the reader's mail server. |
| **Bounced** | Emails the receiving server turned away. |
| **Complained** | Readers who marked the email as spam. |
| **Unsent** | Recipients Kestrel couldn't hand to your email provider. [Unsent recipients](#unsent-recipients), below, says why. |

A line under the counts accounts for every recipient by name, so the numbers always add up. It also names two kinds the counts leave out. A recipient **accepted, awaiting a delivery receipt** was taken by your email provider, with no word yet on what happened next. A **skipped** recipient unsubscribed or was suppressed before their turn, so they were never mailed.

Below that is the full list of recipients. It opens on **Failures** (bounced, complained, and unsent), and **Delivered** and **All** are one click away. You can search it by address. Each row shows the outcome, the provider's own words about it, and when it happened. A person you erased reads as **Erased recipient** in place of their address. **Export recipients (CSV)** downloads the whole list.

### Accepted, then settled

Delivery happens in two stages, and the record keeps them apart. First Kestrel hands each email to your email provider, which accepts it, usually within minutes. Later, the provider reports what happened to each email: delivered, bounced, or complained. Those reports can lag by seconds or by days.

So a send is **sent** once every recipient has been handed off. Its record then keeps updating as reports arrive. The page says **Settling** while it waits, and **Complete** once every accepted email is confirmed. Some accepted emails are never confirmed at all, so a send can stay **Settling** for good. That's normal, not a fault.

"Delivered" in Kestrel always means confirmed, never just accepted. So a count can rise for days after a send finishes, and an email can be accepted without ever showing as delivered.

## Unsent recipients

An unsent recipient never got this post, and is still on your list. They get your next post as usual.

A recipient is recorded unsent in two cases:

- **Their own email kept failing.** When handing off one address hits a passing error, Kestrel tries again a few times, then records it unsent. The row's detail gives the provider's words.
- **You chose Assume not sent.** Rarely, Kestrel can't tell whether your provider took some emails. The send waits for you, and **Resolve…** on its page asks you to decide. **Assume not sent** is the safe default: those readers may miss this post, but no one is mailed twice.

A problem with your email provider itself never marks anyone unsent. While the provider is down, or refusing your account, the send waits and tries again. Once the problem is fixed, it carries on from where it stopped.

## Bounces and complaints

A bounce or a complaint usually arrives after the send has finished, and lands on the record when it does. Kestrel acts on it for you, so a bad address can't keep hurting your sending reputation:

- **A hard bounce** means the address can't receive mail, such as one that doesn't exist. Kestrel suppresses it, so it's never mailed again.
- **A soft bounce** is temporary, such as a full mailbox. It's counted on the record, and the address stays on your list.
- **A complaint** means the reader marked your email as spam. Kestrel suppresses the address, so it's never mailed again.

The record's list says **Hard bounce** or **Soft bounce** on each row. A suppression doesn't change anyone's subscription. Under **Subscribers**, a suppressed address keeps its status and carries a label saying why: **bounced**, **complaint**, **blocked**, or **erased**. **Legend**, beside the counts, says what each label means. Choose the **suppressed** count to list only those subscribers. [Sending rules](02-sending-rules.md#what-kestrel-handles) says why this matters to mailbox providers.

When a recent send's bounces reach about 5% of its recipients, the dashboard warns you. That's about the rate at which email providers start to review a sender, so it's worth finding out why.

### Lifting a suppression

Kestrel never lifts a suppression on its own, and neither does an import. Only you can, deliberately. Do it only when you know the address works again, such as a reader who tells you their mailbox is fixed. Mailing an address that keeps bouncing, or a reader who marked you as spam, can hurt every send after it.

A block is yours to lift: **Unblock** in the subscriber's ⋯ menu, which asks you to confirm. It's offered for a block you made, or one an import brought. The dashboard has no control for lifting a bounce or a complaint, but Claude can do it for you through the API, as [Working with Claude](07-working-with-claude.md) describes. Lifting a suppression changes nothing on past records: the bounce or complaint stays where it happened.

## Notifications

Kestrel emails you when a send finishes, and when a send runs into a problem it can't settle on its own. So you only need to open the dashboard to act.

Set the address under **Settings → Notifications**, in **Send notifications to**. **Send a test notification** checks that one arrives. With no address set, Kestrel sends nothing, and doesn't save anything up for later.

You're told:

- **When a send finishes,** with how many emails your provider accepted, how many were unsent, and how many were skipped.
- **When your provider refuses your account,** with the provider's own words and what they point to. Amazon SES reports a spent daily quota this way too.
- **When a send is held because no email provider is connected,** and that it goes out once one is.
- **When a send stays in progress too long.**
- **When a send waits for you to resolve it.**
- **When a send missed its time,** going out late or not at all.
- **When Claude imports a list for you,** with what the import changed.

Each notification links straight to the page it's about. Each event is told once, not again while it lasts, and the dashboard keeps showing it until it clears. A bounce spike is shown on the dashboard, but isn't emailed.

The **Last notification** row in the same section says whether the latest one was **Delivered** or **Not delivered**. Notifications are separate from your newsletter: one that fails never delays or changes a send.

Whoever runs your Kestrel chooses how notifications are sent. By default they go through your newsletter's own email provider. Then the one about your provider refusing your account can't reach you, since that provider would refuse it too. Whoever runs your Kestrel can send them another way that avoids this, as [Notifications through Cloudflare's email](../guides/03-notifications.md) describes.

## Seeing what's happening

The **Dashboard** shows what needs you first, then what's going on:

- **A health block,** only when something needs your attention, such as a send waiting for you to resolve it. Red needs you to act; amber is worth a look.
- **Active sends,** a card for each send going out now, with its progress.
- **Subscribers,** counts of **Confirmed**, **Pending**, **Unsubscribed**, and **Suppressed**. Each opens the list filtered to that group.
- **Sent,** your five latest sends, each with its **Delivered** count and a link to its public page.

**Sent** in the sidebar has the rest: anything that needs attention, your scheduled sends, sends in progress, and every send so far. Search them by subject, or turn on **With delivery failures** to list only sends with a bounce, a complaint, or an unsent recipient.

Wherever a send is listed, its number is **Delivered**, with any complaints, bounces, or unsent recipients named beside it. Every page keeps up on its own, so you never need to reload.

While a send goes out, its page shows two bars. The first fills as your provider accepts each email, and the second fills behind it as deliveries are confirmed. A label beside the subject says how it's going, such as **Sending**, **Retrying**, or **Backing off**.

## The post's public page

Your post goes up in your archive the moment its send starts. So the "view in browser" link in every email works as soon as it lands. Its publish date is the day its send started.

The page shows the exact copy that was sent, never a fresh rendering of it. Kestrel adds a light frame for the browser: your publication's name, the publish date, a link back to the archive, and a way to subscribe. It also leaves out the parts that only make sense in an inbox, such as the unsubscribe link and your mailing address. No reader's address ever appears on it.

A sent post can't be changed, and neither can its page. The sign-off shows your publication as it was when you sent the post, while the frame shows it as it is now. The page's address is permanent, so links to it keep working.

Open it from **View published post ↗** on the send's record, or **Archive ↗** in the dashboard's **Sent** list. **View publication ↗** in the sidebar opens your home page, which links into your archive. [Name your publication](03-name-your-publication.md) says where your name, logo, and address appear.

Next, see what Claude can do for you through the same API in [Working with Claude](07-working-with-claude.md).
