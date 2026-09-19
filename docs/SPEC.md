# Kestrel Specification

The high-level, abstract description of Kestrel, the newsletter app. It describes what the system is, what it guarantees, and how it's shaped, not how it's built. The concrete schema lives in `migrations/`, the routes in `src/app.ts`, and the code's structure in `src/`; this document does not restate them.

**Who this is for.** The implementer and the maintainer, human or Claude, and anyone deciding whether Kestrel's guarantees fit their newsletter. It is written for a cold reader: each section stands on its own.

**Status.** A living document that tracks `main`. The rule for keeping it in step with the code is `.claude/rules/maintainer.md`.

**How to read it.** §1 to §3 are the contract: what the app is, the six nouns, and the six invariants. §4 to §12 walk each area of the system. The appendix records what was decided, with the alternative each choice was made over, and what was deliberately deferred.

---

## 1. What this is

An application for writing a newsletter and sending it to subscribers. The publisher writes a post in Markdown, sees exactly what the email will look like, and schedules it for a future date and time, usually days out. Until it fires, the scheduled post stays visible and cancelable; the publisher reviews it in that window, and then it goes out on its own. The app keeps the subscriber list, remembers what it sent, and preserves each post as a permanent page.

Three roles appear in this document. The **publisher** writes posts and sends them. The **developer** deploys and runs the app. The **reader** subscribes and receives the newsletter. One person is often both publisher and developer; the document names the role, not the person.

The foundation that makes all of this work is a single HTTP API. Everything the publisher does reaches Kestrel through it, and it has exactly two clients: a **web editor** the publisher drives by hand, and **Claude**, working the same API on their behalf. Both do the same work through it, so Claude does nothing the publisher couldn't do in the editor, and neither reaches past what the API exposes. One API over one copy of the data keeps the two from ever drifting apart. Two other parties reach the app without touching that authoring surface: readers, through a small set of public pages (subscribe, confirm, unsubscribe, and the archive), and the email provider, which reports delivery outcomes back through signature-verified webhooks.

```mermaid
flowchart LR
    subgraph app[Kestrel]
        api[Authoring API]
        public[Public pages]
        store[(Database + object storage)]
    end
    publisher([Publisher]) --> editor[Web editor] --> api
    publisher --> claude[Claude] --> api
    api --> store
    public --> store
    api --> provider[Email provider] --> reader([Reader])
    reader --> public
    provider -. bounces, complaints .-> api
```

Content lives in the app's own database, with every version of a post kept as a revision. Images are uploaded to a post and referenced by name; the publisher never touches an upload URL. Every Send freezes the rendered email, and that frozen copy *is* both the reader's "view in browser" page and the permanent record of what went out.

### What it isn't

- **Not a general CMS.** It serves the newsletter's own reader surface (a landing page, the archive index, and the per-post pages), and only that. It doesn't author arbitrary pages or replace your main website or blog.
- **Not multi-channel.** Email only. Cross-posting to a website, RSS, or social is out of scope.
- **Not a marketing automation suite.** No drip sequences, funnels, or A/B campaigns. One post, reviewed, sent to your subscribers.

---

## 2. The model

Six nouns make up the whole domain: the first three are content, the last three are the audience and the record.

**Post** — one piece the publisher writes and sends: a Markdown body plus its metadata, editable while a draft, frozen once scheduled, and closed once sent. Its metadata is a **subject** and a **slug**. The subject is the email's subject line, and it also names the post in the list and seeds the slug. The slug is the post's path in the archive. The subject is the one field you must set to send.

**Revision** — a saved version of a post's Markdown and metadata. Every save writes one. This is the versioning that files would have given you for free, handed back deliberately.

**Image** — a file belonging to a post, referenced by name in the Markdown. The app stores it, sizes it, and resolves it to an absolute URL at render time.

**Subscriber** — an email address with a consent state: pending, confirmed, or unsubscribed. Only confirmed subscribers receive sends.

**Send** — one dispatch of a post, created the moment the post is scheduled, not when it fires. It holds the frozen render, the fire time, and after firing, who it reached and how it went. Never rewritten once sent. Of the six nouns this is the one that collides with a verb, so this document writes the noun capitalized: a *Send* is always this record, and lowercase *send* is only ever the act.

**Suppression** — an address that hard-bounced or complained and must not be mailed again until you clear it deliberately.

### The lifecycle

A post has three states and a Send has four, and the two advance on different clocks: the post's state says whether it can be edited, the Send's says how far the dispatch has gone.

| Post | Send | What it means |
| --- | --- | --- |
| **draft** | none | Being written. Editable. |
| **scheduled** | **scheduled** | The render is frozen onto a Send and the post is locked. The Send is visible and cancelable until it fires: this is the review window (§6). |
| **scheduled** | **sending** | The Send has fired and is delivering. The post's state holds, but it is past the window: it can no longer be edited or canceled. |
| **sent** | **sent** | Dispatch is complete. The Send is the permanent record of what went out, and the post is closed. |
| **draft** | **canceled** | The publisher canceled the Send during its window. The post is unlocked and editable again; the canceled Send stays as a record but is no longer active. |

Only one Send per post can be active (scheduled or sending) at a time (§6), so the pair above is always unambiguous. Scheduling a draft again after a cancel creates a new Send; the old one is history.

---

## 3. Invariants

Six guarantees. In a newsletter the guarantees that matter are about consent, delivery, and the record. Every mechanism in this spec upholds one of these.

**I1 — Nothing is sent without recorded consent.** Only confirmed subscribers receive a send. Confirmation is double opt-in and timestamped, so for every delivery there is a record of when that person asked to be on the list.

**I2 — Unsubscribe is immediate and final.** From the moment an unsubscribe is recorded, no further mail reaches that person: a Send already in flight skips them if they have not yet been handed off to the provider, and no later Send includes them. There is no window in which they still get one, and it is never silently reversed.

**I3 — What went out is preserved exactly.** Every Send freezes its rendered HTML. The reader's "view in browser" page and the permanent record are that same frozen copy — not a re-render, which could differ. Any public chrome an archived post carries never rewrites the reviewed content.

**I4 — A post is sent at most once per Send, to each person at most once.** Triggering a Send is idempotent. A retry, a double-click, or a resumed Send never mails anyone twice.

**I5 — A test is a real test.** The email you send yourself to check is produced by the same render path as the email that goes to the list. A clean test is a guarantee, not a lookalike.

**I6 — Nothing is delivered without a window to stop it.** Every send becomes a visible, cancelable Send before any mail leaves, for as long as the publisher scheduled and never less than the **minimum lead** (§6). Nothing fires the instant it's requested. This window is the review gate.

### What follows

- **The schedule is the safety.** Because a send exists as a cancelable Send before it fires, a person and Claude can prepare one unattended and still have a window to catch a mistake (I6). This is the newsletter's place where something irreversible is visible before it happens.
- **The archive is the record.** There is no separate "what did the email look like" store to build later (I3). The page a reader opens is the artifact, and it's the very copy that was reviewed.
- **Consent is data you own, and can prove.** Not a setting on a provider you'd have to trust and can't export (I1).
- **You can always resend safely.** Because a Send tracks who it reached, a failed or interrupted Send resumes instead of starting over (I4).

---

## 4. Authoring

You write in Markdown, in the web editor or through the API. Both do the same thing: they read and write posts and their revisions. A post needs only a **subject** and a body to start; the **slug** (auto-derived from the subject) rounds out the metadata, and the inbox **preheader** is derived from the body at render time. A post is editable only while it's a draft; scheduling locks it (§6).

Subject is deliberately the primary field. For an email that is what the reader sees in their inbox, so it is also what names the post in the editor's list and what seeds the slug — one field carrying the weight rather than a separate "title" you'd have to keep in sync with it.

### Revisions

Every save writes a new revision holding that version's Markdown and metadata. The post points at its current revision; the history is the list behind it. Markdown is small and diffs cleanly, so each revision stores the whole body rather than a delta — simpler, and there's no reconstruction step to get wrong.

This gives you a full edit history, the ability to see what changed between two versions, and — because a scheduled post's content is frozen into its Send anyway (I3) — a clear separation between "the post as it is now" and "the post as it was sent."

### Concurrent edits

One post has two clients that can write it at once — two browser tabs, and Claude editing through the same API — so the authoring API is **optimistically concurrent**, and the rule is *notify, don't clobber.*

Because each save advances the post's current revision, that revision id is its version token. A save may carry the revision it was based on; if that base no longer matches the post's current revision, another writer got there first, and the save is rejected rather than landed, returning the newer revision and who wrote it. A save that omits a base is unchecked (last-write-wins), so a client that doesn't participate still works.

The editor participates on both ends. It sends the base on every save, so a stale save surfaces an **out-of-date notice** instead of overwriting: *Reload* discards the local edits and loads the other version, *Keep editing* keeps the local copy so the next save writes on top of the other. It also watches for a newer revision while open, covering another browser and Claude alike, which a same-browser signal would miss, so the writer is warned *before* investing more effort, not only when they save. The notice names who changed it (the revision's author; Claude's saves show as "Claude") and re-arms only when a genuinely newer revision appears.

### Images

Adding an image is uploading it *to a post* and referencing it by name — you upload the file `cover.jpg` to the post, then write `![A stack of paperbacks on a windowsill](cover.jpg)` in the Markdown. That's the whole workflow. No endpoint hands you a URL to paste back in; the reference is just the filename, the same way you'd write it if the image sat in a folder next to the post. At render time the app resolves `cover.jpg` to the stored file's absolute URL and the right size for email. The alt text lives inside the reference, so it's never a separate step and is easy to require.

This is deliberately the one thing many systems get wrong — GitHub included, where text is API-addressable but an image is a side upload that returns an opaque URL you have to bridge yourself. Here the author manages one thing, the post, and the image is part of it.

---

## 5. Preview and the reader surface

Preview means two concrete things, and both are the same render aimed differently.

**View in browser** — a hosted page showing the post rendered as the email. Before scheduling it's a live render of the current draft; the link is how you eyeball layout without leaving your desk. Once scheduled, it shows the frozen copy that will fire.

**Send test** — the real email, rendered and delivered to an address you name, so you can see it in an actual mail client where the rendering finally counts. A test comes in two shapes, both through the one render path (I5): a **post test** sends a specific post to a named address; a **template test**, from the email-template surface, sends a synthetic sample post so the publisher can proof the *layout* in a real inbox without picking a post. A template test always renders the **saved** template — the one that will ship — not unsaved editor content, so a clean template test is a real guarantee and never a lookalike; the surface saves any pending edits before it sends. The default recipients (§9) pre-fill both.

There is exactly **one render path**. It turns a post into the email, and the preview, the test, and the real send all call it. That's what makes I5 hold: if the test looks right, the send is right, because they're the same code producing the same output. Email rendering is client-dependent enough that a faithful web preview isn't sufficient on its own — so the test send is the thing you trust before scheduling, and the view-in-browser page is the convenient first look.

When a post is scheduled, its render freezes (I3) and the view-in-browser page stops being a live draft render and becomes the exact copy that will fire and, afterward, the permanent archive of what was mailed.

### The public reader surface

Because the app is self-contained (§11), it serves its own reader-facing pages, not only per-post archives. It carries the newsletter's identity — the publication name, tagline, and logo (§9) theme these pages, so the reader surface reads as *the publication*, not the tool. Three public pages, all indexable and none ever bouncing a visitor toward an admin path (§11):

The **landing page** is the front door at `/` — the one page a reader reaches by typing the bare domain. It carries the identity and a subscribe call to action, features the latest post, lists recent ones, and links into the full archive. Because it is the bare-domain page, it must be public and must never link into the access-gated admin surface.

The **archive index** lists every sent post, newest first, each linking to its post page. It lives at the archive base path (§11) — the same prefix the post pages sit under, so the list and the posts it links to share one origin and one configured path. It carries the same identity and subscribe call to action as the landing page.

A **post page** serves that post's frozen render (I3). When the archive lives on the app's own origin rather than inside a surrounding website, the page may add light public chrome — a masthead with the newsletter name and the publish date, a link back to the index, a subscribe prompt, and the publication's display font and background, so its headings share the editorial voice of the reader surface and it sits on the same ground — so a shared post reads as part of a publication and not a raw forwarded email. That chrome fills reserved anchors the render leaves in the frozen copy — the same idea as the unsubscribe placeholder — so it appears only in the browser, never in a sent email (a web font can't load in an inbox anyway), and the reviewed content is served unchanged (I3). The archive URL an email carries — its "view in browser" and every shared link — is built from the configured archive origin and base path (§11), so the same render is reachable at a stable, public address forever.

On a local dev instance only, the reader surface also carries a small, clearly-marked "Open dashboard" shortcut into the editor (on the landing page and archive index) — a developer convenience, structurally absent once deployed. It is the one deliberate exception to never linking toward admin, allowed because a local instance has no access wall in front of the editor; §11 states the rule and the carve-out.

---

## 6. Scheduling and sending

Sending is built around a review window, because the window is what makes it safe to prepare a Send days ahead — by hand or with Claude — and let it go out unattended. **Scheduling is the main path; sending immediately is the deliberate exception.**

### Scheduling a post

Scheduling a post for a future time does three things at once: it **freezes the render** into a new Send in `scheduled` state (this frozen copy is the review artifact, exactly what will fire, and the eventual archive — one object doing all three, I3 and I6); it **soft-locks the post**, so it can't drift away from what was reviewed; and it **records the fire time**.

A post **must have a non-empty subject** to schedule or send. The subject is the one field the reader sees in their inbox, and a send is irreversible (I4), so the freeze that both scheduling and sending-now go through rejects an empty (or whitespace-only) subject before anything is frozen, the same guard for both clients. An empty body is only warned about, not blocked. The editor also flags an empty subject as a render warning and disables its Schedule / Send-now buttons, but the freeze is the authority.

From then until it fires, the scheduled Send is **visible and cancelable** (I6). This window is the review gate. The publisher and Claude review it, test emails go to real inboxes, and if anything's wrong the publisher cancels it. The intended rhythm is to schedule days ahead, so the window is generous.

### The soft-lock

A scheduled post is frozen from casual edits. To change it the publisher **cancels** the scheduled Send, which unlocks the post, then edits, re-tests, and re-schedules. Editing stays easy but becomes deliberate, and it resets the review.

The guarantee that falls out: *what fires is exactly what was last reviewed and tested*, because the only way to change a scheduled post is to schedule it again, and scheduling re-freezes the render. Since no one is at the keyboard at fire time, that last approving test is the sign-off, and the lock is what stops the post drifting from it. Freezing at schedule time also makes the Send immune to app deploys during the multi-day window: the render was captured up front, so a change to the renderer in between can't alter what goes out.

A post has **at most one active (scheduled or sending) Send** at a time — the thing that keeps a post from being scheduled, and sent, twice. This holds even across concurrent requests, so a second schedule can never slip through. Re-scheduling after a Send finishes, is canceled, or fails is unaffected — only active Sends are constrained. I4 and I6 rest on this: cancel, the status view, and the sweep each assume a single, unambiguous active send.

### Moving the fire time

Changing *when* a scheduled Send fires is not a content change, so it does not go through the cancel → edit → re-schedule path. The fire time can be **moved directly** on the scheduled Send: it stays the same Send, still the post's one active Send, still visible and cancelable, now aimed at a new time. The frozen render is left exactly as it was (I3) and the review window is preserved rather than reset (I6); only the moment it fires changes. This is deliberately distinct from editing the *content*, which still requires a cancel, because re-scheduling is what re-freezes the render and re-arms the review: the soft-lock above holds. The one guard is the same minimum lead as scheduling: the new time must be at least that far out, and only a Send that has not yet fired can be moved. Once it has begun sending it is past the window, so the move is refused.

### Firing

A periodic sweep (below) delivers scheduled Sends whose time has come. Because the body is already frozen, firing is just delivery: it fans out to confirmed subscribers, filling in each recipient's per-recipient values (their unsubscribe link and the address the post was sent to) where the frozen body left placeholders. Batching, retries, and per-recipient tracking are exactly as for an immediate send.

### Sending now

Sending immediately is the same machinery with the fire time set to now plus the **minimum lead**: a fixed, app-wide interval, minutes rather than seconds, that is the least time any Send spends visible and cancelable before it can fire (I6). It's the exception, not the default: most Sends should carry a real review window, and send-now is for the rare case the publisher has reviewed out-of-band and wants it gone.

### What a Send does when it fires

When a Send fires, the send loop:

1. **Reads the Send**, which already holds the frozen email. A second trigger for the same post finds this record and resumes rather than restarting (I4).
2. **Resolves the audience at that moment**: confirmed subscribers minus suppressed addresses. The audience is not fixed at schedule time, so a reader who confirms after the post was scheduled is included, and the subscriber count shown while a Send is scheduled is a snapshot, not a promise.
3. **Delivers in batches**, checking each recipient's consent and suppression again at hand-off (I2) and marking each one as the provider accepts them. Progress is durable, so an interrupted Send resumes from where it stopped and no one is mailed twice (I4).
4. **Records outcomes as they arrive** (accepted, delivered, bounced, complained) against each recipient.
5. **Closes the Send** as complete, or leaves it open and retrying if the provider is unavailable.

### Two phases: accepted, then settled

Delivery is not one event but two, separated in time. First the Send **hands off** each recipient to the provider and records whether it was **accepted** — this is dispatch, and it finishes in seconds to minutes. Only later do the provider's webhooks report what actually happened to each accepted message — **delivered, bounced, or complained** — and those receipts lag acceptance by anything from seconds to days. So a Send reports two numbers, never conflated: *provider-accepted* (how far the hand-off has gotten) and *delivery-confirmed* (how many receipts have come back).

A Send is **"sent" when dispatch completes** — every recipient handed off or terminal. There is no separate "settled" state and no reconciling sweep that waits for the last receipt: the record simply keeps absorbing webhook events after it is sent, so its delivery and bounce and complaint counts stay live and a recent Send is shown as still settling while receipts trickle in. This is the only honest notion of "done" for a batched transport with lagging webhooks — waiting for every receipt would mean a Send never finishes, because some accepted messages are never confirmed at all.

### The timer

The driver is a periodic **sweep**: a scheduled task on a fixed, short cadence that finds Sends whose fire time has passed and that haven't gone out, and delivers them.

A sweep, rather than a per-post timer set for the exact moment, for one decisive reason: the same loop that fires due Sends also detects Sends that *should* have fired and didn't. A fire time that slips past with no delivery is caught on the next sweep and raised loudly — a dropped Send is as bad as an accidental one (§12). A precise per-object alarm would give you precision a newsletter doesn't need and no built-in way to notice a timer that silently never fired; you'd end up adding a sweep anyway as a backstop. One reconciling loop is simpler and safer than precise timers plus a watchdog, and it tolerates an occasional slow tick by design.

### Recovery

Everything after the fire time is recovery, and §12 holds the posture: retries with backoff, resumption after an interruption, suppression fed by the provider's webhooks, and a loud flag for the few things a person must see. The one rule none of it bends: no automatic behavior ever widens the audience or skips the window.

---

## 7. Subscribers and consent

A subscriber is an email address with a **consent state**, plus an orthogonal **suppression** flag for deliverability. The consent state is the whole story of whether someone has asked to be on the list; suppression is a separate "this address can't or shouldn't be delivered to" mark.

| State | Meaning | In the Send's audience? |
| --- | --- | --- |
| **Pending** | Subscribed but hasn't clicked the confirmation link yet | No |
| **Confirmed** | Completed double opt-in; consent is recorded and timestamped | Yes — unless suppressed |
| **Unsubscribed** | Left the list (their own unsubscribe, or the publisher on their behalf) | No |

**Suppressed** is not a consent state but a flag that can sit on top of one: an address that bounced hard or drew a complaint is excluded from every Send whatever its consent state. That exclusion is a deliverability rule (§10), separate from the consent rule (I1). So a subscriber can be *confirmed and suppressed* at once: consented, but still never mailed. The audience for any Send is exactly *confirmed minus suppressed*.

### Joining

Someone subscribes through a public form, which creates a **pending** subscriber and sends a confirmation email. Clicking the link **confirms** them (double opt-in). Only confirmed subscribers are ever mailed (I1). Double opt-in is a deliberate cost: it's the record that consent was given, it keeps the list clean, and it protects sending reputation.

The confirmation email's **wording** — its subject, the line above the button, the button's label, and an optional reassurance footer — is the publisher's to edit, a runtime preference read and written through the same authenticated API as everything else (§9). Its structure is not: there is no layout choice, and the email always leads with the **publication identity** (logo, name, tagline) as a masthead, which degrades to nothing when no identity is set — a transactional first-touch opens with who it is before the ask, rather than carrying identity author-placed inside a body the way a post does. The **confirm link** is inserted by the app and always present, a required field left blank falls back to a built-in default, and the HTML and plain-text bodies are generated together — so editing the copy can never produce a confirmation email that is wordless, misshapen, or missing the link that records consent (I1). It is transactional, not a post: it does not use the post email template (§9) and carries no unsubscribe link.

### Leaving

Every email carries an unsubscribe link and the one-click header that bulk mail now requires, so a subscriber can leave from the message itself with no login and no confirmation step. Unsubscribing is immediate and final (I2). The publisher can also unsubscribe someone from the admin subscriber list — the same immediate, idempotent effect (I2) — for a request that arrives out of band; it never auto-confirms anyone, only removes consent.

### Two tokens, two jobs

A subscriber carries two independent unguessable tokens, one per job. The **confirm token** drives double opt-in and is one-shot: it is rotated every time a pending or unsubscribed address re-subscribes, so a stale confirmation link can't be replayed (its single-use property comes from confirmation only acting on a *pending* row, not from consuming the token). The **unsubscribe token** is durable — minted once and never rotated, not even across an unsubscribe→resubscribe cycle — because it is the token embedded in the one-click unsubscribe link of every post already delivered. Keeping them separate is what lets that link keep working forever (I2): a returning subscriber can still leave from mail that has been in their inbox since before they last left, which a single rotated-on-resubscribe token would silently break. Neither token can do the other's job — a confirm token can't unsubscribe, and an unsubscribe token can't confirm.

Consent withdrawn (unsubscribe) and undeliverable (suppression) are different states with different owners:

| State | Meaning | Who sets it | Who clears it |
| --- | --- | --- | --- |
| Unsubscribed | Consent was withdrawn | The reader, or the publisher on their behalf | The reader, by re-subscribing |
| Suppressed | Bounced hard or complained | The app, from provider signals | The publisher, deliberately |

### Deferred: topics and segmentation

Topics and segmentation — letting people subscribe to some kinds of post and not others — are a real feature and a deliberate v2. They add a preference center and turn "the audience" into "the audience matching this post's topics." The model is built so this slots in as a filter applied when a Send resolves its audience, plus a few columns on the subscriber, without disturbing anything above.

---

## 8. Seeing what's happening

A small status surface, readable in the editor and through the API, answers the questions you'll actually have.

### What's scheduled, and when does it fire?

The pending Sends, each with its fire time and its frozen render. Because acting on the review window is what makes it real (a window you can't see into or act on isn't one, I6), each carries the two actions that manage a pending Send without editing its content: a **one-call cancel**, and a **one-call reschedule** of the fire time (§6, which moves it without re-freezing). Wherever a scheduled Send is shown, those two actions travel with it.

### What have I sent, and how did it do?

Each sent post is a read-only delivery record, not an editable draft — so it opens a **record view** rather than a locked editor. That view answers *how the Send went*: the audience as resolved when the Send fired, and the delivery-outcome breakdown over it — delivered, bounced, complained, and unsent — read from the per-recipient delivery rows, not just a summary count, and reconciling to the frozen audience. The record is the source of truth for "did it go," because the app is the only thing that knows what actually happened at delivery time.

The record keeps two layers on different clocks: the render (frozen at schedule, I3) and the audience (resolved at fire) are **fixed**, while the **delivery outcomes go on settling** as *this Send's own* webhook events arrive — bounces and complaints land after completion (§12), so the breakdown is the current truth about this one Send, never rewritten by another Send or a later cleared suppression.

Beneath that breakdown are the **per-recipient rows themselves**, so "who bounced" is a look, not a download. They open on the rows that went wrong (bounced, complained, unsent), and you can find any address or widen to the delivered rows; each row carries the provider's error or detail and splits a **hard** bounce (permanent; it suppressed the address) from a **soft** one (transient; counted, never suppressed) on the kind recorded for this Send when the event landed. That kind is a frozen fact of the record, not a read of the current, clearable suppression list, so the split can't drift after the fact. The rows are the record itself, the source of truth. The view links to the archived post (the exact frozen copy readers received, I3), and the whole per-recipient record can be exported, because a record is only inspectable if you can get at it (§12).

Wherever that record is compressed to a single glanceable number, that number is **confirmed delivered**, with any complaints, bounces, or send-time failures called out beside it, each by kind. The number is drawn from the same per-recipient outcomes as the record, so a Send never reads as cleanly "delivered" in a list while its own record shows it bounced. The list can be narrowed to just the Sends with a delivery failure, without reordering it, so newest-first stays and no severity ranking is implied. "Delivered" everywhere means webhook-confirmed, never merely provider-accepted.

### Writing side, dispatch side

The lifecycle (§2) splits what the publisher sees in two. The still-changeable **draft and scheduled** posts are the writing side; a **sent** post is a closed record on the dispatch side. A scheduled post shows on both, as the cancelable draft it still is and as the pending Send it has become. Once its Send *fires*, the post crosses fully to the dispatch side: while it is **sending** it is surfaced as an active Send that opens the live watch (below), never as an editable, cancelable draft. The writing side never offers to edit or cancel a post that is already going out, and opening one leads to the watch rather than a locked editor. The Send's state, not the post's, decides this: the post's own state still reads "scheduled" until the Send completes (§2).

### Is a Send happening right now?

A Send in flight has a **live watch**: the same record page in its in-flight state, so one page is the whole life of a Send from first hand-off to settled archive. It shows the two phases. **Dispatch** (provider-accepted over the audience) comes first, and **delivery** (webhook-confirmed over accepted) fills in behind it as receipts arrive, so delivery always reads as lagging dispatch. Alongside them are a derived **phase** (below), a breakdown of the counts, and rough throughput and time-to-finish. It updates live while the Send is in flight and eases off once it is only settling. An active Send is visible at a glance, and its watch is one click away.

### Is anything wrong right now?

A Send still retrying, a scheduled Send that missed its fire time, a bounce spike, a provider problem. This is the only thing that ever needs your attention, so it's the only thing that surfaces loudly. The **bounce spike** is a real signal, not an approximation: it reads a recent Send's confirmed bounce count over its frozen audience and fires when that rate reaches the provider's danger zone (about 5%, the rate at which a sender is put under review), so it stays quiet through the ordinary trickle of bad addresses and speaks up only when deliverability is genuinely at risk. It is read-only reporting: it warns, it never throttles or halts a reviewed Send (an automatic circuit-breaker is deliberately deferred; see the appendix). One of these conditions carries an action rather than just an alarm: a Send wedged on an ambiguous in-flight delivery (§12) shows its count *and* the control to resolve it, because a stuck Send whose only remedy is raw SQL isn't really inspectable.

### Who's on the list?

The subscriber list is its own view, distinct from send health: it tells the story of the list as a whole rather than of a particular send. It shows the roster — each address, its consent state, and whether it's suppressed — filterable by state and searchable by address, with the list's composition (counts by state: pending, confirmed, unsubscribed, suppressed) at the top. From here you can add a subscriber, which starts the same double opt-in and never auto-confirms, or unsubscribe one (I2). The send-status surface above keeps only scheduling and delivery, so each view answers one question cleanly.

---

## 9. Configuration

A settings surface holds the app's own runtime preferences, the ones with no home in a post or a subscriber: the default recipients the test-send flow pre-fills, the **publication identity** (name, tagline, logo) that themes the public reader surface and the publisher's dashboard, a **mailing address** for the email's footer, the **email template**, and the **wording of the double opt-in confirmation email** (§7). All of it is read and written through the same authenticated API as everything else, so Claude and the editor configure the app the same way.

### Two identities

The **sender**, the `From:` header and its sending domain, is deploy-time infrastructure (§11): the email's authenticated identity, never editable in-app. The **publication identity** is a preference: it themes the reader surface and the dashboard and, with the mailing address, is available to the email template. The two touch at exactly one point, on purpose: until the publisher sets a publication name, the sender's display name stands in for it, so an email is never nameless. The logo is a single global asset, served like any other image.

### The email template

The email template is the single HTML layout that every post is sent inside, authored as a stylesheet plus a logic-less set of placeholders for the post's body and the publication identity. The render path fills it and inlines its CSS (mail clients strip stylesheets), so the presentation *inside* the email is the publication's. Because that render is frozen at schedule (I3) and is the one path preview, test, and send all share (I5), a clean test proves the send, and editing the template never changes a post already scheduled. One rule the template cannot break: every email must carry an unsubscribe link, so a template that omits the unsubscribe placeholder is rejected (as an empty subject is), and a template that somehow can't render falls back to the built-in default rather than shipping a broken or unsubscribe-less post (I2).

### Preferences, never secrets

Configuration splits along one hard line: this surface holds **preferences and never secrets**. The provider choice, its credentials, the access configuration, and the origins are deploy-time infrastructure that lives in the environment and its secrets (documented in the setup guide), never in the database and never readable or writable through the admin API, so a compromised admin session can change a preference but can never reach a credential. For orientation the surface *shows* the deploy-time configuration read-only, next to a link to the guide that explains how to change it.

Every instance can also report its own **build**: the admin surface shows the version and commit it is running, and its API adds the build time, so a bug report or support question can name the exact build a live instance is on. It is build metadata, fixed when the instance was built: neither a secret, nor deploy configuration, nor a preference, and independent of the database's schema version. Like the rest of this surface it is shown, never set.

---

## 10. What email demands

Email asks for things the other channels never would, and this is what the system takes on so a send lands instead of bouncing or going to spam.

**Authentication.** SPF, DKIM, and DMARC on the sending domain (§11). Without them a bulk sender lands in spam or is rejected outright.

**List headers.** `List-Unsubscribe` and `List-Unsubscribe-Post` on every message, so the one-click unsubscribe works from the inbox UI — required by bulk-sender rules. They're set per recipient, pointing at the token-scoped unsubscribe endpoints.

**A plain-text alternative.** Every HTML email ships a text part.

**Batching and idempotency.** Provider send endpoints take tens to a hundred recipients per call, so delivering a Send is a loop of batches. No one is mailed twice on a retry because the app records each recipient the instant the provider accepts them, and a resumed or retried batch simply skips those already accepted (I4). A provider-native idempotency key, where it exists, is an extra guard — never the thing the guarantee rests on.

**Bounce and complaint handling.** Provider webhooks feed suppression: soft bounces are tolerated and counted; a hard bounce or a complaint suppresses the address on its own. Events are matched to a delivery by the provider's message id, so a hard bounce or complaint suppresses the address recovered from that matched row even if the event itself carries no recipient address, so the suppression rule never rests on the provider echoing the recipient back.

The email provider is treated as **transport** — it carries the message and reports what happened — and it sits behind a narrow, two-method seam: one method sends a batch and returns a per-recipient accept/reject; the other verifies a provider webhook's signature and normalizes it into a delivered / bounced / complained event. Everything provider-specific lives inside the adapter. Two adapters ship out of the box: **Resend**, the simplest to set up, and **Amazon SES**, cheaper at scale. They differ most at the webhook: Resend posts a signed webhook directly, while SES routes events through a notification service that adds a subscription-confirmation handshake and its own signature scheme. Hold the seam at the *intersection* of what providers offer — the app owns the list, the consent, the deliveries, and the suppressions itself, so it never leans on a provider's managed suppression or list-hosting. That's what makes swapping providers a swap and not a migration, and it's why a fake in-memory adapter behind the same seam can exercise the whole send-and-resume path with no network.

---

## 11. Domains and deployment

The app is **self-contained by default**: it serves its own reader surface — the landing page, archive index, and per-post pages — on its own origin, and makes no assumption about where, or whether, you run a separate website. Putting the archive under the main site's domain is a real benefit, but an **enhancement the developer opts into**, not a step required to finish setup.

### The self-contained default

One deployed service answers on one hostname — `newsletter.example.com` — and does everything: the admin editor and authoring API, the public reader surface (landing page, archive index, post pages, subscribe/confirm/unsubscribe), previews, and image bytes. The archive origin defaults to the app's own origin, so every "view in browser" link and archive URL points at `newsletter.example.com/archive/{slug}`. A newsletter works end to end no matter where the marketing site lives, or whether there is one.

Two names still earn their own DNS, because they have genuinely different jobs — and the names themselves should say so, unmistakably. The **app and reader surface** live on `newsletter.example.com` — its own name so its uptime is independent of anything else. The **sending identity** lives on `send.example.com` — the From address and its SPF/DKIM/DMARC, off the apex so newsletter reputation can't affect your regular mail. `newsletter.` names the *app*; `send.` names the *mail* — deliberately not near-synonyms, so the two can't be confused or swapped. Avoid `mail.`, which the world treats as an inbound MX host, not a sending identity. **Never send bulk mail from the apex; that's the one rule here that isn't a preference.**

### Optional: surface the archive on the website's apex

The archive can additionally be presented under the main domain, `example.com/archive/*`, so links carry the primary domain's trust, rank with the rest of the site, and never read as an unfamiliar host in an email footer. Archive URLs are permanent (I3); anchoring them to the most durable name, rather than the app's operational subdomain, is the real prize.

This is a routing concern on the apex domain, not a second app: the edge that serves the website forwards the archive path to the *same* app (the setup guide says how), and the archive origin is set to the apex so emitted links use it. Because the archive base path drives both URL generation and the route that serves it, the developer can pick a path that doesn't collide with an existing page on the site.

If the website's edge cannot route to the app, the honest options are a **reverse proxy** from the site's host that forwards `/archive/*` to the app, or a **redirect**: trivial to set up, but one that sends the reader's address bar back to the app host and so forfeits the apex benefit. When neither fits, stay self-contained: the archive on `newsletter.example.com` is a first-class home, not a fallback.

### Admin and public on one host

Self-containment puts two audiences on one name, so the access boundary is the product's spine. **Admin** — the editor and the authoring API — sits behind real authentication (an edge access layer, so you write no auth code). **Public** — the landing page, archive index, post pages, subscribe / confirm / unsubscribe, and media — is deliberately open, protected where it must be by unguessable per-subscriber tokens, because a reader clicking unsubscribe from their inbox has no account to log in with.

The admin surface also carries the **setup guide**, the deploy-and-operate documentation rendered read-only from its Markdown source in the repository, and an **API reference** generated from the route registration itself. Because the reference and the running routes come from one registration, the documented access tier and the enforced gate cannot disagree, and a new route appears in the reference with nothing else to edit. That is why this spec carries no endpoint table: a static list here would only drift from the generated one.

One rule falls out and is easy to get wrong: **no public entry point may redirect or link into an access-gated path.** The public front door, `/`, is the landing page, served to everyone; it must never bounce a visitor to the admin editor, which sits behind the access layer's login wall. Express the public surface as one explicit allowlist of path prefixes; everything else is admin. The single, deliberate exception is the dev-only "Open dashboard" shortcut described in §5 — a presentation-only link the reader surface shows solely on a local dev instance, where the editor carries no access wall; it leaves this allowlist, and the route gate it draws, untouched, and is structurally absent once deployed.

The access layer must also admit a non-interactive principal — a service credential for Claude, distinct from the interactive human login — without weakening the human gate. That such a credential exists is the requirement; how it's issued is the implementor's call. As defense in depth the app also re-verifies the access assertion itself, so a misconfigured edge policy can't silently expose admin routes.

There is **one identity contract**: the app verifies a signed token and resolves a principal, either a **human** (who carries an email) or a **service** (Claude or automation, with no email). Everything upstream normalizes to this. In deployed environments the access layer issues the token for both principals: a human SSO login, and a **service token** for Claude, which is Claude's API credential (carried by a Claude Desktop connector, for instance) with no separate token system needed. In local development there is no edge, so a dev-only stand-in issues the token under the same contract; it is structurally inert once deployed. The interactive client (the editor) reflects the resolved identity and offers a sign-out; it never prompts for a credential in a deployed environment. An agent-native alternative, where Claude authenticates *as the publisher* rather than through a service principal, is deferred (appendix) and would slot into this same contract.

### Environments

Three environments, each with its own database, its own storage, and — the load-bearing rule — its own mail transport, so development can never reach a real inbox.

| | Database | Email transport | Access |
| --- | --- | --- | --- |
| Development (local) | Local, disposable | Dead-end: the fake in-memory adapter | localhost only |
| Staging (deployed) | Separate | Provider sandbox / test domain → only addresses you own | Behind access control |
| Production (deployed) | Real | Real provider, real sending domain | Behind access control |

Staging exists because email's real failure modes — DKIM alignment, inbox rendering, the bounce webhook round-trip, one-click unsubscribe in a real client — only appear once deployed, and a real test send to yourself is the only way to prove them before a real send to subscribers.

The platform these roles run on, and the concrete deploy-and-operate steps (provisioning, the access application, connecting a provider and its webhook, sending-domain DNS, wiring the archive to a website, the verify checklist), are the setup guide under `docs/setup/`, which the admin surface also serves. This spec holds the *why*; that guide holds the *how*.

---

## 12. Failure posture

The posture is: recover quietly, escalate rarely, always be inspectable.

Send-time transient errors — a rate limit, a brief provider hiccup — retry with backoff inside the Send, per batch. The retry is safe because it is scoped by what the delivery record already marks as accepted: a recipient marked accepted is never re-sent, so idempotency comes from durable per-recipient state, not from the provider. An interrupted Send — the service restarts mid-send — resumes from that same progress, mailing only those not yet accepted (I4). A provider outage keeps the Send open and retrying, and surfaces on the status view only once it has clearly stopped being transient. Bounces and complaints arrive by webhook after the Send and update the delivery and suppression records on their own.

### The reported phase

What the watch (§8) reports is a **derived phase**, computed live from the Send's current signals and never stored — deliberately distinct from the stored send state, which is only the coarse lifecycle (scheduled → sending → sent). The phase is the finer story of *how* a Send in flight is faring: **progressing** (handing off cleanly), **retrying** (some recipients hit a transient error and are being retried), **backing-off** (work remains but nothing is in flight — paused between sweep ticks after a rate limit or a batch failure), or **needs-attention** (the wedged case below). A Send that is sent but still absorbing receipts reports as **settling**, then **complete** once every accepted recipient is confirmed. Because it is derived, the phase can never disagree with the record; it is a reading of the same durable state, not a second copy of it.

The in-flight surface is **observe-only** but for one control: the watch reports, and the only action it offers is Resolve (below). It never pauses, throttles, or auto-halts a reviewed Send — no automatic decision widens the audience, skips the window, or stops a Send the publisher approved. A bounce spike is *reported* loudly (§8) but never *acted on*: the report is observation, not automation. Publisher pause/resume and an automatic circuit-breaker are deferred (appendix): both are new automation over a reviewed Send, and the loud bounce-spike report is the seam a circuit-breaker would later hook into.

### The one ambiguity a human resolves

There is a single delivery outcome the app cannot resolve on its own: a **transport error mid-send on a provider with no idempotency key** — the request left but no response came back, so whether the provider accepted that recipient is genuinely unknown. Blind-retrying it would risk mailing the person twice (I4), so the send loop deliberately does *not* retry it: it leaves that recipient in flight and moves on. The safe refusal has a cost — an in-flight recipient with an unknown fate keeps the Send from ever completing, so it stays open, and the sweep flags it loudly (a stuck Send, an aging in-flight delivery). Detecting it is not enough on its own; "always be inspectable" has to mean actionable in the UI, not a note in the logs whose only remedy is raw SQL.

So the status surface carries the one manual control in the whole send path: **the publisher adjudicates the ambiguous in-flight recipients of a stuck Send**, choosing the safe outcome — *assume not sent* (recorded unsent; the address is simply picked up by the next post, and is never re-mailed within this Send) or *assume sent* (recorded delivered, for when they have confirmed it in the provider's console). Either choice lets the Send reach its normal completion gate and finish. This control touches only the ambiguous, still-in-flight rows — it can **never** re-mail a recipient the record already marks accepted (I4) — and it is the *only* place a human overrides an automatic delivery decision. It is a resolution of an existing ambiguity, not a new way to send: it never widens the audience and never mails anyone.

The one failure that is raised loudly rather than absorbed is a scheduled Send that misses its fire time. A Send that should have happened and didn't is as bad as one that shouldn't have and did — precisely because nothing happened and no one was watching — so the sweep that fires due Sends also catches missed ones and escalates. The schedule lives as durable rows, so a restart or redeploy can't lose it; the sweep simply re-reads and continues.

Nothing here retries in a way that could re-mail a person, because every retry is scoped by what the delivery record already marks as accepted. And nothing is hidden: the frozen render plus per-recipient state means "what happened" is always a query, never a guess. That inspectability is what gives you confidence things are working — the goal set for this app — without making you watch it.

---

# Appendix — decisions and deferred

## Decided

Each entry names the alternative it was chosen over and points to the section that carries the reasoning. This list is the index of what was ruled out, not a second copy of the why.

- **Content lives in the app's database**, over Markdown files in a repo (§2, §4). Files would have given `git` versioning for free but cost the build-free live preview, uploaded images, and the one API; the revision table hands the versioning back.
- **One API and no side door**, over a file-editing path beside it (§1). Removes the whole class of "did the file and the record disagree" bugs, and is what makes Claude-in-production safe: the same API, with the same review window in front of every Send.
- **Self-contained by default, apex-optional**, over requiring the website's domain (§11). Requiring it would have welded a finished newsletter to the website's infrastructure and turned "hook it up to your site" into a wall for anyone whose site is hosted elsewhere.
- **Subject is the primary post field**, over a separate title (§4). A title would only be a second field to keep in sync; the preheader is derived from the body for the same reason.
- **Scheduling is core**, over deferring it to a later version (§6). The review window is the safety model against any bad send, a person's as much as an agent's; send-now is the narrow exception and still carries the minimum lead.
- **Soft-lock at schedule**, over "fire the current version" (which could send something untested) and "fire the scheduled version but allow edits" (which breaks the guarantee) (§6).
- **A reconciling sweep**, over per-post alarms (§6). Alarms would add precision a newsletter doesn't need and still require a sweep to catch a timer that never fired.
- **Full-text revisions**, over delta chains (§4).
- **The archive page is the record**, over a separate email archive (§5).
- **Email only**, over multi-channel (§1).
- **Two providers out of the box behind one seam**, over a single hard-wired transport (§10): Resend for the simplest setup, Amazon SES for cost at scale. The list, consent, and record stay in the app's database, which is what makes a provider change a swap and not a migration.
- **The app hosts consent and unsubscribe itself**, over leaning on the provider's list features (§7). A provider's account-level suppression list may sit underneath as a redundant safety net, but the consent record and the unsubscribe flow are the app's.
- **Archive pages carry light public chrome**, over a bare frozen render (§5): a masthead, a link back to the index, and a subscribe prompt, filled into reserved anchors so the reviewed content is never rewritten (I3).

## Deferred

- **Topics and segmentation.** A preference center and an audience filter; the model is built so it slots in (§7).
- **Open/click analytics.** The delivery record can carry it; not needed to send well.
- **A `git` mirror of content.** If edit-in-my-own-editor is ever missed, the database can export Markdown to a repo for versioning and offline editing, without moving the source of truth back out of the app.
- **Publisher pause/resume and an automatic deliverability circuit-breaker.** Both are new automation over a reviewed Send; the bounce-spike report (§8) is the seam a circuit-breaker would hook into (§12).
- **Claude authenticating as the publisher.** An agent-native login through the platform's managed OAuth, in place of the distinct service principal; it slots into the one identity contract (§11).

## Open

Nothing at present. A question that is raised and not yet decided goes here, and moves to *Decided* with the alternative it was chosen over.
