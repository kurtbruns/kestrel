# Import format

Kestrel imports a subscriber list in one documented format, `kestrel-subscribers/1`, and exports the whole list in the same format. This page describes the format, what an import does to each address, and the limits.

Kestrel never guesses what another service's export means, because a wrong guess about who agreed to be emailed can't be taken back. An export from Sendy, Mailchimp, or anywhere else is converted to this format first, by Claude or by hand. The API serves everything on this page at `GET /api/imports/format`, generated from the same definition the importer reads with, along with a CSV template at `GET /api/imports/template.csv` and a plain-list template at `GET /api/imports/template.txt`.

## Two kinds of file

- **The full CSV (preferred).** It carries unsubscribes, bounces, and how each person joined. It's what the export writes, and you can open it in a spreadsheet to check it before importing.
- **A plain list (`.txt`).** One address per line, for a list that is only addresses. You say what they all are: subscribed (the default), unsubscribed, or bounced. It loses how each person joined, any times, the evidence of consent, and mixed states.

The file's name decides which it is: `.csv` or `.txt`. Anything else is refused.

## The CSV

A CSV file (RFC 4180, UTF-8) with a header row of the column names below, in any order, then one row per address. Column names are written exactly, in lowercase. A row records what the source claims, never what Kestrel will do: the import decides that, under the rules further down.

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

Here is a small file:

```
email,status,opt_in,origin,suppression,unsubscribed_at,evidence
ada@example.com,subscribed,double,sendy,,,"{""signup_ip"":""203.0.113.7""}"
grace@example.com,subscribed,single,mailchimp,,,
edsger@example.com,unsubscribed,unknown,unknown,,2025-01-20T08:00:00Z,
bounced@example.com,none,unknown,unknown,bounce,,
```

**Versions.** Adding an optional column keeps the version. Changing what a column means makes a new version. Kestrel reads every version it has published, and refuses one it doesn't know, by name.

## The plain list

- One address per line. Each line is trimmed, blank lines are skipped, and CRLF line endings and a UTF-8 byte-order mark are accepted.
- A line that isn't a single valid address, such as `Name <ada@example.com>` or a typo, is counted as invalid and listed among the rows left out. One bad line doesn't sink a list.
- The whole file is refused when it isn't a plain list at all: not UTF-8 text, a line with a comma, tab, or semicolon (it's a table, so a `.csv`), or not one valid address in it.
- Its rows arrive with `origin: unknown` and `opt_in: unknown`.

## Plan, then commit

An import happens in two steps. Planning shows what the import would do to every row, against your list as it stands, and changes nothing, so you can plan a file as often as you need. Committing applies the plan, all of it or none of it, and sends no email.

The commit needs two things from you when they apply:

- **Your attestation,** when anyone would be confirmed: "Everyone I'm importing as subscribed opted in to receive [your publication]. This isn't a purchased, rented, or scraped list." It is kept with the import, with who gave it and when. An import that only unsubscribes or suppresses needs none.
- **Each send that would grow,** acknowledged by a person. A post goes to the list as it stands when it fires, so an import can add to the audience of a scheduled send, or of one that has just fired and not yet fixed its audience. Claude can attest for you, but can't acknowledge a growing send: you finish that import in the dashboard.

If another import is committed after you plan, plan again. If your list changes between the plan and the commit in any other way, such as a reader unsubscribing, the commit still goes ahead. Every write checks the list as it stands, and the answer reports any row that turned out differently.

## What an import does to each address

Each row gets exactly one outcome. A row that both changes its status and adds a suppression reports its status outcome, and says it added a suppression too.

| Outcome | When |
| --- | --- |
| `create_confirmed` | `subscribed`, with no subscriber and no suppression in Kestrel: added as confirmed. |
| `confirm_pending` | `subscribed`, and pending in Kestrel (never confirmed): confirmed, and its confirmation link no longer works. |
| `unchanged` | Already confirmed in Kestrel, or already in the state the row claims. A subscriber who joined through Kestrel keeps their own record. |
| `mark_unsubscribed` | `unsubscribed`, and confirmed or pending in Kestrel, with no confirmation in Kestrel newer than the row's `unsubscribed_at`: unsubscribed. |
| `create_unsubscribed` | `unsubscribed`, with no subscriber in Kestrel: recorded as unsubscribed, so the list remembers they left. |
| `kept_confirmed_newer` | `unsubscribed`, but the reader confirmed in Kestrel after the source's `unsubscribed_at`: their newer action stands. |
| `kept_unsubscribed` | `subscribed`, but unsubscribed in Kestrel, or pending again after leaving until they confirm in Kestrel themselves. An unsubscribe is never reversed. |
| `blocked_by_suppression` | `subscribed`, but the address carries a suppression in Kestrel, a do-not-contact marker included: never added or confirmed. |
| `suppression_added` | The row carries a suppression and the address has none in Kestrel, or only a do-not-contact marker, and nothing else changes. Applied whatever the row's `status`. |
| `left_out` | `pending` or `none` with nothing to apply: counted, never confirmed. An import sends no email, so it can't start a confirmation either. |
| `invalid` | The address isn't valid. |
| `merged` | A repeat of an address earlier in the file, folded into it. |

A suppression already in Kestrel is never replaced, with one exception: a bounce, a complaint, or a manual suppression replaces a do-not-contact marker left by an erasure, so a known bad address still gets no confirmation. An imported bounce or complaint is kept apart from one Kestrel saw itself, so the list says where each came from.

Anyone can type an address into your subscribe form, which puts a reader who left back to pending until they confirm. An import treats such a reader as unsubscribed, so it never confirms someone who left in Kestrel.

**Repeats of an address** are folded into one row first. Its status is the first of unsubscribed, subscribed, pending, and none that any repeat claims, and its suppression the first of erased, complaint, bounce, and manual. Its opt-in is the weakest claim. It keeps the earliest consent times and the latest unsubscribe and suppression times, and the origin and evidence of the row whose status won.

## How imported subscribers read

A subscriber an import confirmed is **confirmed**, like anyone who confirmed in Kestrel, and gets your posts. How they joined shows beside their state: imported, with the origin and opt-in method the file claimed, and the evidence. That holds even when the file says they confirmed through Kestrel itself. Only a confirmation Kestrel recorded reads as Kestrel's double opt-in, and a subscriber who later confirms in Kestrel becomes Kestrel's own.

## Limits

- **Rows:** up to 10,000 in one import. On the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset), up to 1,000, since Free's 10 ms of CPU a request can't plan and commit more. Set [`SUBREQUEST_BUDGET`](01-configuration.md#subrequest_budget) on Workers Paid to take 10,000. Split a larger list into several files.
- **Size:** a request of at most 10 MB, and `evidence` of at most 500 bytes a row.
- **Database writes on Workers Free:** D1's free plan allows a limited number of rows written a day, and each imported subscriber writes several, one for each index on the table. If you import several large files in a day on Workers Free, send your next post the day after.

## Exporting

The export reads your whole list out in this format, a page at a time, at `GET /api/subscribers/export`. Each page holds up to 1,000 rows on the Workers Free plan's limits, or 10,000 otherwise, and its `next` value asks for the page after it. Following `next` until it's `null` gives every address exactly once, even if the list changes while you read. An address added or removed partway through may or may not appear. To make one CSV in this format, write the pages' rows under a single header. In the CSV, a value that starts with `=`, `+`, `-`, or `@` is written with an apostrophe before it, so a spreadsheet shows it as text rather than running it as a formula; an import takes the apostrophe off again. It includes every subscriber with how they joined, their evidence, and their suppression, and every address suppressed with no subscriber behind it, written as `status: none`. A confirmed subscriber is written as `subscribed`. Importing an export into another Kestrel carries the list over: the same states and suppressions, with every confirmation arriving as imported, carrying its original evidence. Pending subscribers are left out on the way in, since an import sends no confirmation.
