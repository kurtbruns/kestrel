# Your list: importing and exporting

Almost no one starts a newsletter with an empty list. Kestrel brings your existing subscribers over from another service with the consent they gave there, and lets you take the whole list out again at any time, in the same format.

This page covers the file Kestrel reads, what an import does and why, the limits, and getting your list back out. The dashboard's **Subscribers → Import** walks you through an import, and Claude reads this same page through the API.

## The file Kestrel reads

Kestrel reads one documented format, `kestrel-subscribers/1`: a CSV file with a header row and one row per address. A row says what your old service recorded about a person, and Kestrel decides what that means here. Five columns decide what happens to a row:

| Column | What it holds |
| --- | --- |
| `email` | The address. Kestrel trims it and ignores capitals when it matches. |
| `status` | `subscribed`, `pending`, `unsubscribed`, or `none` (an address with no consent claim, present only to carry a bounce or a block). |
| `opt_in` | How consent was collected: `double`, `single`, or `unknown`. |
| `origin` | Where consent was collected, as a short name such as `sendy` or `mailchimp`. |
| `subscribed_at` | When they subscribed, with its time zone, such as `2024-03-01T09:30:00Z`. Optional. |

The optional columns carry the rest: a bounce or complaint (`suppression`), when someone confirmed or left, and `evidence`, the old service's own consent details, such as a signup IP or a form name. [Import format](../reference/03-import-format.md) describes every column and value.

The import screen's **Download example file (CSV)** gives you `kestrel-import-example.csv`, a few rows that show each case. Open it in a spreadsheet to see the shape, and save your file as CSV UTF-8.

Kestrel never guesses what another service's export means, because a wrong guess about who agreed to be emailed can't be taken back. An export in any other shape is refused, with what's wrong and where. Convert it first, with Claude or by hand.

## A plain list of addresses

If all you have is addresses, a `.txt` file with one address per line works too. After you choose it, you say what the addresses are: **Subscribed** (the default), **Unsubscribed**, or **Bounced**. Every address in the file is that one kind, so a plain list of subscribers and a plain list of bounces are two imports.

A plain list loses what a full CSV carries: how and where each person joined, when, and the evidence. Kestrel records how they joined as unknown. When your old service can export more than addresses, prefer the CSV.

## Let Claude convert your export

Exports from Sendy, Mailchimp, Substack, and other services all differ, and change without notice. If you use Claude Code with your instance, ask it to do the conversion:

```
Please import my Sendy subscribers from ~/Downloads/sendy-export.csv into the newsletter.
```

Claude's `/migrate-list` skill reads Kestrel's format from your instance and asks you what anything ambiguous in the export means. It converts a few rows for you to check, then checks Kestrel's plan against its own counts. It asks for your attestation before it imports anyone as a subscriber. [Connect Claude to the API](../guides/01-connect-claude.md) sets Claude up.

If a scheduled post would reach the people the import adds, Claude stops and asks you to finish in the dashboard: choose the converted file Claude left in your working folder under **Subscribers → Import**, and the same plan appears for you to confirm.

## What an import does

Nothing changes when you choose a file. Kestrel plans the import first and shows you what it would do to every row. You see who is added as a subscriber, who is recorded as having left, and who is suppressed, and which rows are repeats, invalid, or left out. You can download the rows that won't be imported as subscribers, to check them against your file. Only when you press **Import** does anything change, and then the import applies whole, or not at all. If a reader's consent changed between your plan and the import, for example someone unsubscribed or confirmed, their row follows your list as it stands then, and the result lists each row that turned out differently from the plan you saw. An import sends no email.

To import anyone as a subscriber, you confirm that everyone you're importing as subscribed opted in to receive your publication, and that the list isn't purchased, rented, or scraped. If you're unsure about some people, take them out of the file before importing. Kestrel keeps your attestation with the import's record.

If a post is scheduled, it goes to the list as it stands when it sends, so the people an import adds would receive it. The plan names each such post and how many more people it would reach, and you acknowledge each one before importing.

If your list or its scheduled posts changed since the plan in a way the plan rests on, such as another import, Kestrel plans your file again and shows you the new plan as things stand now, before anything happens.

## Why your old service's record is honored

Kestrel normally confirms every new subscriber with double opt-in: they click a link in an email before they get any posts. Asking your whole list to confirm again would lose readers who already said yes, and would mail every one of them a request they didn't expect. So an import carries over what your old service recorded instead: the consent each person gave there, how it was collected, and your word for it.

Kestrel holds a few lines that an import can't cross:

- **Someone who left stays gone.** An address that unsubscribed here is never subscribed again by an import, whatever the file says. Only that reader can come back, by confirming here.
- **A bounce, a block, or a do-not-contact marker here always wins.** An import never lifts a suppression, so an address known to fail is never mailed. An address you erased keeps only a do-not-contact marker, and an import never records a subscriber for it again, not even as one who left.
- **A reader's newer choice stands.** If someone confirmed here after your old service says they left, they stay subscribed.
- **Repeats are folded together,** and when one row says subscribed and another says unsubscribed, unsubscribed wins.

In the subscriber list, imported subscribers are **Confirmed** and receive your posts. The **How they joined** column says they were imported, with the service and the opt-in method your file gave, such as "Imported · Sendy, single opt-in". Only someone who confirmed through Kestrel itself reads as "Double opt-in". Choose **View subscriber** from a subscriber's ⋯ menu to see the evidence.

## Limits

- **Rows.** One import takes up to 10,000 rows on Workers Paid, or 1,000 on the free plan's limits. The import screen says which applies to you. Split a larger list into several files, and import them one at a time.
- **Daily database writes on the free plan.** Cloudflare's free plan allows a fixed number of database writes a day, and stops your newsletter until midnight UTC once they're used up. Bringing in a large list, in one file or several, and sending to it on the same day can use them up. So when the day's imports would use most of the day's writes, the plan warns you and suggests importing the file the next day, by UTC, and a post scheduled for a day imports have written warns you too, suggesting it go out the next day. Neither warning stops anything.
- **When to move to Workers Paid.** From about 5,000 subscribers, it's recommended to move to the $5 Workers Paid plan, which has no daily limit on writes. Whoever runs your Kestrel makes the change, as [Go live](../get-started/06-go-live.md#as-your-list-grows) describes.

## When readers reply

Kestrel only sends mail. A reader who replies to a post writes to your From address, so replies reach you once that address forwards to an inbox you read. Whoever runs your Kestrel sets that up outside Kestrel.

When a reader replies asking to be taken off the list, carrying it out is up to you, since Kestrel never sees the reply. Find them under **Subscribers**, and choose **Unsubscribe** from their ⋯ menu. It takes effect at once.

When a reader asks you to delete their data, choose **Erase** from their ⋯ menu instead. It removes the subscriber and how they joined, and can't be undone. It keeps only a do-not-contact marker, or the bounce, complaint, or block the address already had, so the address is never mailed again. The reader can still rejoin by subscribing and confirming themselves.

## Taking your list out

**Subscribers → Export** downloads your whole list as one CSV in the same format: every subscriber with their state, how they joined and the evidence, and every bounced, complained, blocked, or erased address. It's yours to keep as a backup, or to import into another Kestrel, which carries the list over as it is. A value a spreadsheet would run as a formula is written as text, so the file is safe to open.

Claude can read the same export a page at a time through the API, at `GET /api/subscribers/export`.
