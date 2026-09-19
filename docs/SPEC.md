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

Content lives in the app's own database, with every version of a post kept as a revision. Images are uploaded to a post and referenced by name; the publisher never touches an upload URL. Every send freezes the rendered email, and that frozen copy *is* both the reader's "view in browser" page and the permanent record of what went out.

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

**Send** — one dispatch of a post, created the moment the post is scheduled, not when it fires. It holds the frozen render, the template revision it was made with (§9), the fire time, and after firing, who it reached and how it went. Never rewritten once sent. The word is both the verb and, like *build* or *deploy*, the noun for one instance of it; the article tells them apart, and *a send* always means this record.

**Suppression** — an address that hard-bounced or complained and must not be mailed again until you clear it deliberately.

### The lifecycle

A post has three states and a send has four, and the two advance on different clocks: the post's state says whether it can be edited, the send's says how far the dispatch has gone.

| Post | Send | What it means |
| --- | --- | --- |
| **draft** | none | Being written. Editable. |
| **scheduled** | **scheduled** | The render is frozen onto a send and the post is locked. The send is visible and cancelable until it fires: this is the review window (§6). |
| **scheduled** | **sending** | The send has fired and is delivering. The post's state holds, but it is past the window: it can no longer be edited or canceled. |
| **sent** | **sent** | Dispatch is complete. The send is the permanent record of what went out, and the post is closed. |
| **draft** | **canceled** | The publisher canceled the send during its window. The post is unlocked and editable again; the canceled send stays as a record but is no longer active. |

Only one send per post can be active (scheduled or sending) at a time (§6), so the pair above is always unambiguous. Scheduling a draft again after a cancel creates a new send; the old one is history.

---

## 3. Invariants

Six guarantees. In a newsletter the guarantees that matter are about consent, delivery, and the record. Every mechanism in this spec upholds one of these.

**I1 — Nothing is sent without recorded consent.** Only confirmed subscribers receive a send. Confirmation is double opt-in and timestamped, so for every delivery there is a record of when that person asked to be on the list.

**I2 — Unsubscribe is immediate and final.** From the moment an unsubscribe is recorded, no further mail reaches that person: a send already in flight skips them if they have not yet been handed off to the provider, and no later send includes them. There is no window in which they still get one, and it is never silently reversed.

**I3 — What went out is preserved exactly.** Every send freezes its rendered HTML. The reader's "view in browser" page and the permanent record are that same frozen copy — not a re-render, which could differ. Any public chrome an archived post carries never rewrites the reviewed content.

**I4 — A post is sent at most once per send, to each person at most once.** Triggering a send is idempotent. A retry, a double-click, or a resumed send never mails anyone twice.

**I5 — A test is a real test.** The email you send yourself to check is produced by the same render path as the email that goes to the list. A clean test is a guarantee, not a lookalike.

**I6 — Nothing is delivered without a window to stop it.** Every send becomes a visible, cancelable send before any mail leaves, for as long as the publisher scheduled and never less than the **minimum lead** (§6). Nothing fires the instant it's requested. This window is the review gate.

### What follows

- **The schedule is the safety.** Because a send exists as a cancelable send before it fires, a person and Claude can prepare one unattended and still have a window to catch a mistake (I6). This is the newsletter's place where something irreversible is visible before it happens.
- **The archive is the record.** There is no separate "what did the email look like" store to build later (I3). The page a reader opens is the artifact, and it's the very copy that was reviewed.
- **Consent is data you own, and can prove.** Not a setting on a provider you'd have to trust and can't export (I1).
- **You can always resend safely.** Because a send tracks who it reached, a failed or interrupted send resumes instead of starting over (I4).

---

## 4. Authoring

You write in Markdown, in the web editor or through the API. Both do the same thing: they read and write posts and their revisions. A post needs only a **subject** and a body to start; the **slug** (auto-derived from the subject) rounds out the metadata, and the inbox **preheader** is derived from the body at render time. A post is editable only while it's a draft; scheduling locks it (§6).

Subject is deliberately the primary field. For an email that is what the reader sees in their inbox, so it is also what names the post in the editor's list and what seeds the slug — one field carrying the weight rather than a separate "title" you'd have to keep in sync with it.

### Revisions

Every save writes a new revision holding that version's Markdown and metadata. The post points at its current revision; the history is the list behind it. Markdown is small and diffs cleanly, so each revision stores the whole body rather than a delta — simpler, and there's no reconstruction step to get wrong.

This gives you a full edit history, the ability to see what changed between two versions, and — because a scheduled post's content is frozen into its send anyway (I3) — a clear separation between "the post as it is now" and "the post as it was sent."

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

**Send test** — the real email, rendered and delivered to an address you name, so you can see it in an actual mail client where the rendering finally counts. A test comes in two shapes, both through the one render path (I5): a **post test** sends a specific post to a named address; a **template test**, from the email-template surface, sends a synthetic sample post so the publisher can proof the *layout* in a real inbox without picking a post. A template test always renders the **saved** template — the one that will ship — not unsaved editor content, so a clean template test is a real guarantee and never a lookalike; the surface saves any pending edits before it sends. Once a post is scheduled, a post test sends its **frozen copy**, exactly as the fire path will, so the test and the view-in-browser page never disagree about what is going out. The default recipients (§9) pre-fill both.

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

Sending is built around a review window, because the window is what makes it safe to prepare a send days ahead, by hand or with Claude, and let it go out unattended. **Scheduling is the main path; sending immediately is the deliberate exception.**

### Scheduling a post

Scheduling **makes the email**. It does three things at once: it **freezes the render** into a new send (the one copy that is the review artifact, what will fire, and the archive, I3), it **soft-locks the post** so it can't drift from what was reviewed, and it **records the fire time**. The frozen copy captures three inputs as they stand at that moment: the post's content, the email template (§9), and the publication identity. None of them reaches a scheduled send afterward; a change to any of them applies to posts scheduled from then on, and reaches a post already scheduled only by making it again. The fire time must be at least the **minimum lead** out, a fixed, app-wide interval measured in minutes rather than seconds; the freeze rejects anything closer, so every send, however requested, spends at least that long visible and cancelable (I6). From then until it fires the send is **visible and cancelable** (I6): the publisher and Claude review it, test emails go to real inboxes, and if anything is wrong the publisher cancels it.

A post **must have a non-empty subject** to schedule or send. The subject is what the reader sees in their inbox and a send is irreversible (I4), so the freeze rejects an empty or whitespace-only subject before anything is frozen, the same guard for both clients; the editor won't offer Schedule or Send now without one, but the freeze is the authority. An empty body draws a warning from the editor and is not blocked.

### The soft-lock

A scheduled post is locked: the API refuses every write to it (body, metadata, images) until its send is canceled, so the lock is enforced, not merely shown. To change it the publisher **cancels** the scheduled send, which unlocks the post, then edits, re-tests, and schedules it again. Editing stays easy but becomes deliberate, and it resets the review.

Making a post again **never silently changes its look**. Fixing a word is never a template decision: if the template has changed since the post was last made, the request to schedule or send it must name the revision to use, the one it had or the current one, and is refused until it does; when nothing has changed, no choice is asked (§9). The identity is not versioned and is always current when a post is made; renaming the publication is a global act, not a look.

The guarantee: *what fires is exactly what was last reviewed and tested*, because the only way to change a scheduled post is to cancel it and schedule it anew. Since no one is at the keyboard at fire time, that last approving test is the sign-off, and the lock is what stops the post drifting from it. Freezing at schedule time also makes the send immune to app deploys during the window: the render was captured up front, so a change to the renderer in between can't alter what goes out.

A post has **at most one active (scheduled or sending) send** at a time, and this holds even across concurrent requests: a second schedule request is refused rather than slipping through, and a second send-now finds the existing send and returns it. Finished and canceled sends don't count, so scheduling again is unaffected. I4 and I6 rest on this: cancel, the status surface (§8), and the sweep (below) each assume a single, unambiguous active send.

### Moving the fire time

Changing *when* a scheduled send fires is not a content change, so it doesn't go through cancel → edit → schedule again. The fire time is **moved directly** on the scheduled send (the one-call *reschedule*, §8): the same send, still the post's one active send, still visible and cancelable, now aimed at a new time. The frozen render is untouched (I3) and the review window is preserved rather than reset (I6). Two guards: the new time must be at least the minimum lead out, and only a send that has not yet fired can be moved; once it has begun sending it is past the window.

### Sending now

Sending immediately is the same machinery with the fire time set to now plus the minimum lead, so even an "immediate" send is a visible, cancelable send for those minutes (I6). It's for the case the publisher has reviewed out of band and wants it gone; most sends should carry a real window.

### The timer

The driver is a periodic **sweep**: a scheduled task on a fixed, short cadence that finds sends whose fire time has passed and that haven't gone out, and delivers them. A send the sweep finds late is still delivered: the window closed at the fire time, so lateness is a delay, not a new decision. A sweep rather than a per-send alarm for one decisive reason: the same loop that fires due sends also notices a fire time that has slipped past without delivery, and raises it loudly (§12). One reconciling loop is simpler and safer than precise timers plus a watchdog, and it tolerates an occasional slow tick by design.

### What a send does when it fires

Because the body is already frozen, firing is just delivery. The send loop:

1. **Reads the send**, which already holds the frozen email. A second trigger, whether a later sweep tick or a repeated request, finds this record and resumes rather than restarting (I4).
2. **Resolves the audience at that moment**: confirmed subscribers minus suppressed addresses. The audience is not fixed at schedule time, so a reader who confirms after the post was scheduled is included, and the subscriber count shown while a send is scheduled is a snapshot, not a promise.
3. **Delivers in batches**, checking each recipient's consent and suppression again at hand-off (I2), filling in their unsubscribe link and address where the frozen body left placeholders, and marking each one as the provider accepts them. Progress is durable, so an interrupted send resumes from where it stopped and no one is mailed twice (I4).
4. **Records outcomes as they arrive** (accepted, delivered, bounced, complained) against each recipient.
5. **Closes the send** as complete, or leaves it open and retrying if the provider is unavailable.

### Two phases: accepted, then settled

Delivery is two events separated in time. First the send **hands off** each recipient to the provider and records whether it was **accepted**: this is dispatch, and it finishes in seconds to minutes. Only later do the provider's webhooks report what actually happened to each accepted message, **delivered, bounced, or complained**, lagging acceptance by anything from seconds to days. So a send reports two numbers, never conflated: *provider-accepted* and *delivery-confirmed*.

A send is **"sent" when dispatch completes**, every recipient handed off or terminal; the record then keeps absorbing receipts, so its delivery, bounce, and complaint counts stay live afterward. That is the only honest "done" for a batched transport with lagging webhooks: waiting for every receipt would mean a send never finishes, because some accepted messages are never confirmed at all.

### Recovery

Everything that goes wrong after the fire time is recovery, and §12 holds the posture: retries with backoff, resumption after an interruption, suppression fed by the provider's webhooks, and a loud flag for the few things a person must see. The one rule none of it bends: no automatic behavior ever widens the audience or skips the window.

---

## 7. Subscribers and consent

A subscriber is an email address with a **consent state**, plus an orthogonal **suppression** flag for deliverability. The consent state is the whole story of whether someone has asked to be on the list; suppression is a separate "this address can't or shouldn't be delivered to" mark.

| State | Meaning | In the send's audience? |
| --- | --- | --- |
| **Pending** | Subscribed but hasn't clicked the confirmation link yet | No |
| **Confirmed** | Completed double opt-in; consent is recorded and timestamped | Yes, unless suppressed |
| **Unsubscribed** | Left the list (their own unsubscribe, or the publisher on their behalf) | No |

**Suppressed** is not a consent state but a flag that can sit on top of one: an address that bounced hard or drew a complaint is excluded from every send whatever its consent state, so a subscriber can be *confirmed and suppressed* at once, consented but never mailed. The audience for any send is exactly *confirmed minus suppressed*. The two marks have different owners, which is what keeps them distinct: unsubscribed is the reader's to set (or the publisher's, on their behalf) and the reader's to clear by subscribing again; suppressed is set by the app from the provider's signals and cleared only by the publisher, deliberately. Suppression is a deliverability rule (§10), separate from the consent rule (I1).

### Joining

Someone subscribes through a public form, which creates a **pending** subscriber and sends a confirmation email. Clicking the link **confirms** them (double opt-in). Only confirmed subscribers are ever mailed (I1). Double opt-in is a deliberate cost: it's the record that consent was given, it keeps the list clean, and it protects sending reputation.

The confirmation email's **wording** (its subject, the line above the button, the button's label, and an optional reassurance footer) is the publisher's to edit, a runtime preference (§9). Its structure is not: it always opens with the publication identity as a masthead, because a first-touch email says who it is before the ask, and the masthead degrades to nothing when no identity is set. The confirm link is inserted by the app and always present, a required field left blank falls back to a built-in default, and the HTML and plain-text bodies are generated together, so no edit can produce a confirmation email that is wordless, misshapen, or missing the link that records consent (I1). It is transactional, not a post: it does not use the post template and carries no unsubscribe link.

### Leaving

Every email carries an unsubscribe link and the one-click header that bulk mail now requires, so a subscriber can leave from the message itself with no login and no confirmation step. Unsubscribing is immediate and final (I2). The publisher can also unsubscribe someone from the subscriber list, the same immediate, idempotent effect, for a request that arrives out of band; it never auto-confirms anyone, only removes consent.

### Two tokens, two jobs

A subscriber carries two independent unguessable tokens, one per job, and neither can do the other's. The **confirm token** drives double opt-in and is one-shot: it is rotated whenever a pending or unsubscribed address subscribes again, so a stale confirmation link can't be replayed. The **unsubscribe token** is durable and never rotated, not even across an unsubscribe and a resubscribe, because it is embedded in the one-click link of every post already delivered: a returning subscriber can still leave from mail that has sat in their inbox since before they last left (I2). One token doing both jobs would go dead in delivered mail the moment it rotated.

### Deferred: topics and segmentation

Topics and segmentation, letting people subscribe to some kinds of post and not others, are a real feature and a deliberate v2. They add a preference center and turn "the audience" into "the audience matching this post's topics." The model is built so this slots in as a filter applied when a send resolves its audience, plus a few columns on the subscriber, without disturbing anything above.

---

## 8. Seeing what's happening

A small status surface, readable in the editor and through the API, answers the questions you'll actually have.

### What's scheduled, and when does it fire?

The pending sends, each with its fire time and its frozen render. Because acting on the review window is what makes it real (a window you can't see into or act on isn't one, I6), each carries the actions that manage a pending send without editing its content: a **one-call cancel**, a **one-call reschedule** of the fire time (§6, which moves it without re-freezing), and, only when the template has changed since the send was made, a **one-call update** to the current template (§9). Wherever a scheduled send is shown, those actions travel with it, and a send made with an older template than the current one says so.

### What have I sent, and how did it do?

Each sent post is a read-only delivery record, not an editable draft — so it opens a **record view** rather than a locked editor. That view answers *how the send went*: the audience as resolved when the send fired, and the delivery-outcome breakdown over it — delivered, bounced, complained, and unsent — read from the per-recipient delivery rows, not just a summary count, and reconciling to the frozen audience. The record is the source of truth for "did it go," because the app is the only thing that knows what actually happened at delivery time.

The record keeps two layers on different clocks: the render (frozen at schedule, I3) and the audience (resolved at fire) are **fixed**, while the **delivery outcomes go on settling** as *this send's own* webhook events arrive — bounces and complaints land after completion (§12), so the breakdown is the current truth about this one send, never rewritten by another send or a later cleared suppression.

Beneath that breakdown are the **per-recipient rows themselves**, so "who bounced" is a look, not a download. They open on the rows that went wrong (bounced, complained, unsent), and you can find any address or widen to the delivered rows; each row carries the provider's error or detail and splits a **hard** bounce (permanent; it suppressed the address) from a **soft** one (transient; counted, never suppressed) on the kind recorded for this send when the event landed. That kind is a frozen fact of the record, not a read of the current, clearable suppression list, so the split can't drift after the fact. The rows are the record itself, the source of truth. The view links to the archived post (the exact frozen copy readers received, I3), and the whole per-recipient record can be exported, because a record is only inspectable if you can get at it (§12).

Wherever that record is compressed to a single glanceable number, that number is **confirmed delivered**, with any complaints, bounces, or send-time failures called out beside it, each by kind. The number is drawn from the same per-recipient outcomes as the record, so a send never reads as cleanly "delivered" in a list while its own record shows it bounced. The list can be narrowed to just the sends with a delivery failure, without reordering it, so newest-first stays and no severity ranking is implied. "Delivered" everywhere means webhook-confirmed, never merely provider-accepted.

### Writing side, dispatch side

The lifecycle (§2) splits what the publisher sees in two. The still-changeable **draft and scheduled** posts are the writing side; a **sent** post is a closed record on the dispatch side. A scheduled post shows on both, as the cancelable draft it still is and as the pending send it has become. Once its send *fires*, the post crosses fully to the dispatch side: while it is **sending** it is surfaced as an active send that opens the live watch (below), never as an editable, cancelable draft. The writing side never offers to edit or cancel a post that is already going out, and opening one leads to the watch rather than a locked editor. The send's state, not the post's, decides this: the post's own state still reads "scheduled" until the send completes (§2).

### Is a send happening right now?

A send in flight has a **live watch**: the same record page in its in-flight state, so one page is the whole life of a send from first hand-off to settled archive. It shows the two phases. **Dispatch** (provider-accepted over the audience) comes first, and **delivery** (webhook-confirmed over accepted) fills in behind it as receipts arrive, so delivery always reads as lagging dispatch. Alongside them are a derived **phase** (below), a breakdown of the counts, and rough throughput and time-to-finish. It updates live while the send is in flight and eases off once it is only settling. An active send is visible at a glance, and its watch is one click away.

### Is anything wrong right now?

A send still retrying, a scheduled send that missed its fire time, a bounce spike, a provider problem. This is the only thing that ever needs your attention, so it's the only thing that surfaces loudly. The **bounce spike** is a real signal, not an approximation: it reads a recent send's confirmed bounce count over its frozen audience and fires when that rate reaches the provider's danger zone (about 5%, the rate at which a sender is put under review), so it stays quiet through the ordinary trickle of bad addresses and speaks up only when deliverability is genuinely at risk. It is read-only reporting: it warns, it never throttles or halts a reviewed send (an automatic circuit-breaker is deliberately deferred; see the appendix). One of these conditions carries an action rather than just an alarm: a send wedged on an ambiguous in-flight delivery (§12) shows its count *and* the control to resolve it, because a stuck send whose only remedy is raw SQL isn't really inspectable.

### Who's on the list?

The subscriber list is its own view, distinct from send health: it tells the story of the list as a whole rather than of a particular send. It shows the roster — each address, its consent state, and whether it's suppressed — filterable by state and searchable by address, with the list's composition (counts by state: pending, confirmed, unsubscribed, suppressed) at the top. From here you can add a subscriber, which starts the same double opt-in and never auto-confirms, or unsubscribe one (I2). The send-status surface above keeps only scheduling and delivery, so each view answers one question cleanly.

---

## 9. Configuration

A settings surface holds the app's own runtime preferences, the ones with no home in a post or a subscriber: the default recipients the test-send flow pre-fills, the **publication identity** (name, tagline, logo) that themes the public reader surface and the publisher's dashboard, a **mailing address** for the email's footer, the **email template**, and the **wording of the double opt-in confirmation email** (§7). All of it is read and written through the same authenticated API as everything else, so Claude and the editor configure the app the same way.

### Two identities

The **sender**, the `From:` header and its sending domain, is deploy-time infrastructure (§11): the email's authenticated identity, never editable in-app. The **publication identity** is a preference: it themes the reader surface and the dashboard and, with the mailing address, is available to the email template. The two touch at exactly one point, on purpose: until the publisher sets a publication name, the sender's display name stands in for it, so an email is never nameless. The logo is a single global asset, served like any other image.

### The email template

The email template is the single HTML layout that every post is sent inside, authored as a stylesheet plus a logic-less set of placeholders for the post's body and the publication identity. The render path fills it and inlines its CSS (mail clients strip stylesheets), so the presentation *inside* the email is the publication's. Because that render is frozen at schedule (I3) and is the one path preview, test, and send all share (I5), a clean test proves the send.

There is one template, and it has a **history**: every save writes a template revision, the current template is the latest, and a send records the revision it was made with (§2). Editing the template therefore never changes a post already scheduled; it applies to posts scheduled from then on. Saving it reports which scheduled posts keep the previous revision, so the change is never silent, and each of those sends can be **updated** to the current template in one call: the send is made again with the same content and fire time, still visible and cancelable, and the publisher can test it. Making a post again after a cancel, when the template has changed since, requires the request to name the revision to use, the one the post had or the current one (§6); it names a revision, not "the current one", so the choice is exact even if the template is saved between reading and acting. Any past revision can be **restored**, which writes it as a new revision rather than rewriting history, so a template edit that went wrong is undone the way a post edit is. One rule the template cannot break: every email must carry an unsubscribe link, so a template that omits the unsubscribe placeholder is rejected (as an empty subject is), and a template that somehow can't render falls back to the built-in default rather than shipping a broken or unsubscribe-less post (I2).

### Preferences, never secrets

Configuration splits along one hard line: this surface holds **preferences and never secrets**. The provider choice, its credentials, the access configuration, and the origins are deploy-time infrastructure that lives in the environment and its secrets (documented in the setup guide), never in the database and never readable or writable through the admin API, so a compromised admin session can change a preference but can never reach a credential. For orientation the surface *shows* the deploy-time configuration read-only, next to a link to the guide that explains how to change it.

Every instance can also report its own **build**: the admin surface shows the version and commit it is running, and its API adds the build time, so a bug report or support question can name the exact build a live instance is on. It is build metadata, fixed when the instance was built: neither a secret, nor deploy configuration, nor a preference, and independent of the database's schema version. Like the rest of this surface it is shown, never set.

---

## 10. What email demands

Email asks for things the other channels never would, and this is what the system takes on so a send lands instead of bouncing or going to spam.

**Authentication.** SPF, DKIM, and DMARC on the sending domain (§11). Without them a bulk sender lands in spam or is rejected outright.

**List headers.** `List-Unsubscribe` and `List-Unsubscribe-Post` on every message, so the one-click unsubscribe works from the inbox UI — required by bulk-sender rules. They're set per recipient, pointing at the token-scoped unsubscribe endpoints.

**A plain-text alternative.** Every HTML email ships a text part.

**Batching and idempotency.** Provider send endpoints take tens to a hundred recipients per call, so delivering a send is a loop of batches. No one is mailed twice on a retry because the app records each recipient the instant the provider accepts them, and a resumed or retried batch simply skips those already accepted (I4). A provider-native idempotency key, where it exists, is an extra guard — never the thing the guarantee rests on.

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

The posture is: recover quietly, escalate rarely, always be inspectable. The frozen render plus the per-recipient record means "what happened" is always a query, never a guess, and that is what lets the publisher trust the app without watching it.

### Recover quietly

Send-time transient errors (a rate limit, a brief provider hiccup) retry with backoff inside the send, per batch, and an interrupted send resumes from its durable progress, mailing only those not yet accepted (I4; the mechanism is §10's). A provider outage keeps the send open and retrying, and surfaces on the status surface (§8) only once it has clearly stopped being transient. Bounces and complaints arrive by webhook after the send and update the delivery and suppression records on their own (§10).

Everything automatic here is about delivering reliably or not delivering to the wrong people. The in-flight surface is **observe-only** but for one control, Resolve (below): the app never pauses, throttles, or auto-halts a reviewed send, and no automatic decision widens the audience, skips the window, or stops a send the publisher approved. Automation over a reviewed send (pause/resume, a circuit-breaker) is deferred, not forgotten (appendix).

### Escalate rarely

There is one delivery outcome the app cannot resolve on its own: a **transport error mid-send on a provider with no idempotency key**. The request left but no response came back, so whether the provider accepted that recipient is genuinely unknown. Blind-retrying would risk mailing them twice (I4), so the send loop leaves that recipient in flight and moves on. The safe refusal has a cost: a recipient with an unknown fate keeps the send from completing, so it stays open and the sweep flags it loudly as stuck. Detecting it is not enough; "always be inspectable" has to mean actionable, not a note in the logs whose only remedy is raw SQL.

So the status surface carries the one manual control in the whole send path: **the publisher adjudicates the ambiguous in-flight recipients of a stuck send**, choosing *assume not sent* (recorded unsent; the address is simply picked up by the next post) or *assume sent* (recorded delivered, for when they have confirmed it in the provider's console). Either lets the send reach its normal completion gate and finish. The control touches only the ambiguous rows: it can never re-mail a recipient the record already marks accepted (I4), never widens the audience, and never mails anyone. It resolves an existing ambiguity; it is not a new way to send.

The one failure raised loudly rather than absorbed is a scheduled send that misses its fire time. A send that should have happened and didn't is as bad as one that shouldn't have and did, precisely because nothing happened and no one was watching, so the sweep that fires due sends also catches missed ones and escalates (§6). The schedule lives as durable rows, so a restart or redeploy can't lose it; the sweep simply re-reads and continues.

### Always be inspectable

What the watch (§8) reports is a **derived phase**, computed live from the send's current signals and never stored, distinct from the stored send state, which is only the coarse lifecycle (§2). The phase is the finer story of *how* a send in flight is faring: **progressing** (handing off cleanly), **retrying** (some recipients hit a transient error and are being retried), **backing-off** (work remains but nothing is in flight, paused between sweep ticks after a rate limit or a batch failure), or **needs-attention** (the wedged case above). A send that is sent but still absorbing receipts reports as **settling**, then **complete** once every accepted recipient is confirmed. Because it is derived, the phase can never disagree with the record: it is a reading of the same durable state, not a second copy of it.

---

# Appendix — decisions and deferred

## Decided

Each entry names the alternative it was chosen over and points to the section that carries the reasoning. This list is the index of what was ruled out, not a second copy of the why.

- **Content lives in the app's database**, over Markdown files in a repo (§2, §4). Files would have given `git` versioning for free but cost the build-free live preview, uploaded images, and the one API; the revision table hands the versioning back.
- **One API and no side door**, over a file-editing path beside it (§1). Removes the whole class of "did the file and the record disagree" bugs, and is what makes Claude-in-production safe: the same API, with the same review window in front of every send.
- **Self-contained by default, apex-optional**, over requiring the website's domain (§11). Requiring it would have welded a finished newsletter to the website's infrastructure and turned "hook it up to your site" into a wall for anyone whose site is hosted elsewhere.
- **Subject is the primary post field**, over a separate title (§4). A title would only be a second field to keep in sync; the preheader is derived from the body for the same reason.
- **Scheduling is core**, over deferring it to a later version (§6). The review window is the safety model against any bad send, a person's as much as an agent's; send-now is the narrow exception and still carries the minimum lead.
- **Soft-lock at schedule**, over "fire the current version" (which could send something untested) and "fire the scheduled version but allow edits" (which breaks the guarantee) (§6).
- **Scheduling makes the email; one template, with history, pinned per send**, over applying the template at fire time (§6, §9). Applying at fire would let a broken template save reach every scheduled post unattended and would send something other than what was tested. Pinning keeps a re-make from silently changing the look; the history is what makes "keep", "update", and "restore" possible without a second template.
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
- **Publisher pause/resume and an automatic deliverability circuit-breaker.** Both are new automation over a reviewed send, which §12 rules out by default; the bounce-spike report (§8) is the seam a circuit-breaker would hook into.
- **Claude authenticating as the publisher.** An agent-native login through the platform's managed OAuth, in place of the distinct service principal; it slots into the one identity contract (§11).

## Open

Nothing at present. A question that is raised and not yet decided goes here, and moves to *Decided* with the alternative it was chosen over.
