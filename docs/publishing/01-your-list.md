# Bring your existing list

Moving to Kestrel from another newsletter service means bringing your subscribers with you, along with the consent they gave there. This guide explains how to export your list from the old service, convert it to Kestrel's format, and import it under **Subscribers → Import**. It also covers what carries over, the limits on an import, and taking your list out again. Kestrel shows you what an import will do before anything changes, and an import never emails your subscribers.

**The first decision is whether to upgrade to Cloudflare's Workers Paid plan.** Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. With more than about 1,000 subscribers, it's recommended to upgrade before you import. Workers Paid is $5 a month and has no daily cap, and [As your list grows](../guides/09-as-your-list-grows.md) walks through the upgrade.

If you're starting without a list, skip this step and go on to [Write and send a post](04-write-a-post.md).

## 1. Export from your old service

Export everyone your old service knows about, not only your current subscribers. Unsubscribes and bounces matter too: once imported, Kestrel never mails someone who left or an address that fails. Include any consent details the export offers, such as signup dates, IP addresses, or form names. Kestrel keeps them with each subscriber as evidence of their consent.

## 2. Convert it to Kestrel's format

Every service's export is different. Kestrel never guesses what one means, because a wrong guess about who agreed to be emailed can't be taken back. So you convert the export first, to one of two kinds of file:

- **A CSV in Kestrel's format (preferred).** One row per address, with its status, how and where consent was collected, and any bounce or complaint. **Download example file (CSV)** on the import screen shows each case. Save your file as CSV UTF-8.
- **A plain list (`.txt`).** One address per line, all of one kind: subscribed, unsubscribed, or bounced. Nothing else carries over, so use it only when addresses are all you have.

A CSV in Kestrel's format looks like this, with the five columns that decide what happens to each row:

```
email,status,opt_in,origin,subscribed_at
ada@example.com,subscribed,double,sendy,2024-03-01T09:30:00Z
grace@example.com,subscribed,single,mailchimp,
edsger@example.com,unsubscribed,unknown,unknown,
```

[The file format](01-your-list.md#the-file-format), below, describes every column. If you use Claude Code with your instance, it can do the conversion for you, as [Working with Claude](07-working-with-claude.md) describes.

## 3. Import it

Under **Subscribers → Import**, choose your file. Nothing changes yet: Kestrel plans the import and shows what it would do to every row. You see who is added, who is recorded as having left, who is suppressed, and which rows are left out. You can download the rows that won't be imported as subscribers, to check them against your file.

**Import** then applies the plan, all of it or none of it. Before it does, you confirm two things when they apply:

- **That everyone you're importing as subscribed opted in** to receive your publication, and the list isn't purchased, rented, or scraped. Kestrel keeps your attestation with the import.
- **Each scheduled post that would grow.** A post goes to your list as it stands when it sends, so the people you import would receive it.

## What carries over

Asking your whole list to confirm again would lose readers who already said yes. So an import carries over the consent each person gave on your old service, and your word for it. Imported subscribers are **Confirmed** and receive your posts, and **How they joined** shows where they came from, such as "Imported · Sendy, single opt-in".

A few things hold whatever the file says:

- **Someone who unsubscribed here stays unsubscribed,** until they confirm again themselves.
- **A bounce, a block, or an erasure here always wins.** An import never lifts one.
- **A reader's newer choice stands.** Someone who confirmed here after your old service says they left stays subscribed.

## Limits

- **Rows.** Up to 10,000 in one import, or 1,000 on Cloudflare's free Workers plan. The import screen says which applies. Split a larger list into several files, and import them one at a time.
- **The free plan.** On the free Workers plan, an import that would take your list past about 1,000 subscribers recommends Workers Paid, and so do the Dashboard and the Subscribers screen once it's past. A send to more than about 5,000 warns too. None of these stops anything.

## Taking your list out

**Subscribers → Export** downloads your whole list as one CSV in the same format. It holds every subscriber, how they joined, and every bounced, complained, blocked, or erased address. Keep it as a backup, or import it into another Kestrel to carry the list over.

## The file format

This section defines `kestrel-subscribers/1` in full, for whoever converts a file, by hand or with Claude. The API serves the same definition at `GET /api/imports/format`, generated from the one the importer reads with. It serves the example files at `GET /api/imports/template.csv` and `GET /api/imports/template.txt`. A file's name decides its kind, `.csv` or `.txt`, and anything else is refused.

### The CSV

The file is a CSV saved as UTF-8 (in a spreadsheet, **CSV UTF-8**). A header row names the columns below, in any order, then each row is one address. A value with a comma, a quote, or a line break in it is wrapped in double quotes. Each quote inside it is written twice, as spreadsheets write it (RFC 4180). Column names are written exactly, in lowercase. A row records what the source claims, never what Kestrel will do: the import decides that, under the rules further down.

| Column | Required | Values | Meaning |
| --- | --- | --- | --- |
| `email` | yes | an email address | The address, trimmed and lowercased before it is matched. An invalid one is still a row, counted as invalid and reported, never dropped. |
| `status` | yes | `subscribed`, `pending`, `unsubscribed`, `none` | The consent claim. `none` is a known address with no consent claim, present only to carry a suppression. |
| `opt_in` | yes | `double`, `single`, `unknown` | How consent was collected. `unknown` unless the source states it. |
| `origin` | yes | a short lowercase name | Where consent was first collected, as the file claims it: `sendy`, `mailchimp`, `kestrel`, or `unknown`. |
| `suppression` | no | `bounce`, `complaint`, `manual`, `erased` | A suppression on top of `status`: the address bounced, complained, was suppressed by hand, or was erased. |
| `subscribed_at` | no | an instant with its zone | When the person subscribed, if the source states it. |
| `confirmed_at` | no | an instant with its zone | When the person confirmed, if the source states it. |
| `unsubscribed_at` | no | an instant with its zone | When the person left, if the source states it. A reader who confirmed in Kestrel after it stays confirmed. |
| `suppressed_at` | no | an instant with its zone | When the address was suppressed, if the source states it. |
| `evidence` | no | a JSON object, at most 500 bytes | The source's consent-relevant columns, verbatim, such as a signup IP or a form name. Nothing reads it to decide anything: it is the proof of consent and the audit trail of a conversion. |
| `format` | no | `kestrel-subscribers/1` | The version the file is written in. A file without it is read as version 1. |

An instant is a UTC ISO-8601 time with its zone, such as `2024-03-01T09:30:00Z` or `2024-03-01T10:30:00+01:00`. A time without a zone is refused, never interpreted. An optional column may be left out, or left empty on a row.

Any other column is refused, naming it. A source's other columns belong in `evidence`, as JSON. A file whose header names none of these columns isn't in the format at all, and is refused as such.

The example file, `kestrel-import-example.csv`, shows each case: a double opt-in subscriber with evidence, a single opt-in one, someone who left, and a bounced address. Here are the same four with only the columns they use, since an optional column may be left out:

```
email,status,opt_in,origin,suppression,unsubscribed_at,evidence
ada@example.com,subscribed,double,sendy,,,"{""signup_ip"":""203.0.113.7""}"
grace@example.com,subscribed,single,mailchimp,,,
edsger@example.com,unsubscribed,unknown,unknown,,2025-01-20T08:00:00Z,
bounced@example.com,none,unknown,unknown,bounce,,
```

**Versions.** Adding an optional column keeps the version. Changing what a column means makes a new version. Kestrel reads every version it has published, and refuses one it doesn't know, by name.

### The plain list

- One address per line. Each line is trimmed, blank lines are skipped, and CRLF line endings and a UTF-8 byte-order mark are accepted.
- A line that isn't a single valid address, such as `Name <ada@example.com>` or a typo, counts as invalid. It's listed among the rows left out. One bad line doesn't sink a list.
- The whole file is refused when it isn't a plain list at all. That's a file that isn't UTF-8 text, or has no valid address in it. It's also one with a comma, tab, or semicolon in a line, since that makes it a table, so a `.csv`.
- Its rows arrive with `origin: unknown` and `opt_in: unknown`.

### Plan, then commit

An import happens in two steps. Planning shows what the import would do to every row, against your list as it stands. It changes nothing, so you can plan a file as often as you need. Committing applies the plan, all of it or none of it, and emails no subscriber.

The commit needs two things from you when they apply:

- **Your attestation,** when anyone would be confirmed: "Everyone I'm importing as subscribed opted in to receive [your publication]. This isn't a purchased, rented, or scraped list." It is kept with the import, with who gave it and when. An import that only unsubscribes or suppresses needs none.
- **Each send that would grow,** acknowledged by a person. A post goes to the list as it stands when it fires. So an import can add to the audience of a scheduled send, or of one that has just fired and not yet fixed its audience. Claude can attest for you, but can't acknowledge a growing send: you finish that import in the dashboard.

If another import is committed after you plan, plan again. If your list changes between the plan and the commit in any other way, such as a reader unsubscribing, the commit still goes ahead. Every write checks the list as it stands, and the answer reports any row that turned out differently.

### What an import does to each address

Each row gets exactly one outcome. A row that both changes its status and adds a suppression reports its status outcome, and says it added a suppression too.

| Outcome | When |
| --- | --- |
| `create_confirmed` | `subscribed`, with no subscriber and no suppression in Kestrel, and not erased in the file: added as confirmed. |
| `confirm_pending` | `subscribed`, pending in Kestrel (never confirmed), and not erased in the file: confirmed, and its confirmation link no longer works. |
| `unchanged` | Already confirmed in Kestrel, or already in the state the row claims. A subscriber who joined through Kestrel keeps their own record. |
| `mark_unsubscribed` | `unsubscribed`, and confirmed or pending in Kestrel, with no confirmation in Kestrel newer than the row's `unsubscribed_at`: unsubscribed. |
| `create_unsubscribed` | `unsubscribed`, with no subscriber in Kestrel, and not erased in Kestrel or in the file: recorded as unsubscribed, so the list remembers they left. |
| `kept_confirmed_newer` | `unsubscribed`, but the reader confirmed in Kestrel after the source's `unsubscribed_at`: their newer action stands. |
| `kept_unsubscribed` | `subscribed`, but unsubscribed in Kestrel, or pending again after leaving until they confirm in Kestrel themselves. An unsubscribe is never reversed. |
| `blocked_by_suppression` | `subscribed`, but the address carries a suppression in Kestrel, a do-not-contact marker included: never added or confirmed. Also `unsubscribed`, when the address's suppression in Kestrel is the do-not-contact marker an erasure left. An address erased in the file gets this outcome too, when its row is `subscribed` or `unsubscribed` with no subscriber in Kestrel. So does one that's `subscribed` and pending in Kestrel, which stays pending. The file's `erased` suppression is still added. In each case no subscriber is recorded or confirmed, so an import never brings back an erased person's data. |
| `suppression_added` | The row carries a suppression and the address has none in Kestrel, or only a do-not-contact marker, and nothing else changes. Applied whatever the row's `status`. |
| `left_out` | `pending` or `none` with nothing to apply: counted, never confirmed. An import sends no email, so it can't start a confirmation either. |
| `invalid` | The address isn't valid. |
| `merged` | A repeat of an address earlier in the file, folded into it. |

A suppression already in Kestrel is never replaced, with one exception. A bounce, a complaint, or a manual suppression replaces a do-not-contact marker left by an erasure, so a known bad address still gets no confirmation. An imported bounce or complaint is kept apart from one Kestrel saw itself, so the list says where each came from.

Anyone can type an address into your subscribe form, which puts a reader who left back to pending until they confirm. An import treats such a reader as unsubscribed, so it never confirms someone who left in Kestrel.

**Repeats of an address** are folded into one row first. Its status is the first of unsubscribed, subscribed, pending, and none that any repeat claims. Its suppression is the first of erased, complaint, bounce, and manual. Its opt-in is the weakest claim. It keeps the earliest consent times and the latest unsubscribe and suppression times, and the origin and evidence of the row whose status won.

A subscriber an import confirmed is **confirmed**, like anyone who confirmed in Kestrel, and gets your posts. How they joined shows beside their state: imported, with the origin and opt-in method the file claimed, and the evidence. That holds even when the file says they confirmed through Kestrel itself. Only a confirmation Kestrel recorded reads as Kestrel's double opt-in, and a subscriber who later confirms in Kestrel becomes Kestrel's own.

### Limits in detail

- **Rows:** up to 10,000 in one import. On the free Workers plan's limits it's 1,000, since that plan's processing time per request can't plan and commit more. [`SUBREQUEST_BUDGET`](../reference/01-configuration.md#subrequest_budget) tells Kestrel which plan it's on.
- **Size:** an import request of at most 10 MB, and at most 500 bytes of `evidence` a row.
- **The free Workers plan:** it suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. An import's plan recommends Workers Paid when it would leave more than 1,000 confirmed subscribers, and the Dashboard and the Subscribers screen say the same while the list is past it. A scheduled post to more than 5,000 recipients warns before it's scheduled, and its banner repeats the warning while it's scheduled. None of these stops anything. [As your list grows](../guides/09-as-your-list-grows.md) has the numbers behind them.

### Exporting

The export reads your whole list out in this format, a page at a time, at `GET /api/subscribers/export`. Each page holds up to 1,000 rows on the free Workers plan's limits, or 10,000 otherwise. Its `next` value asks for the page after it. Following `next` until it's `null` gives every address exactly once, even if the list changes while you read. An address added or removed partway through may or may not appear.

To make one CSV in this format, write the pages' rows under a single header. The dashboard's **Export** button, on the Subscribers screen, does this for you and downloads the whole list as one CSV. In the CSV, a value that starts with `=`, `+`, `-`, or `@` is written with an apostrophe before it. A spreadsheet then shows it as text rather than running it as a formula, and an import takes the apostrophe off again.

The export includes every subscriber with how they joined, their evidence, and their suppression. It also includes every address suppressed with no subscriber behind it, written as `status: none`. A confirmed subscriber is written as `subscribed`.

Importing an export into another Kestrel carries the list over: the same states and suppressions, with every confirmation arriving as imported, carrying its original evidence. Pending subscribers are left out on the way in, since an import sends no confirmation.
