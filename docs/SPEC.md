# Kestrel — specification

The high-level, abstract description of Kestrel, the newsletter app. It describes what the system is, what it guarantees, and how it's shaped — not its columns and routes. The concrete schema lives in `migrations/` and the routes in `src/app.ts`; read `src/` for the code's structure. This document does not restate them. When behavior and this document disagree, one of them is a bug.

---

## 1. What this is

An application for writing a newsletter and sending it to subscribers. You write a post in Markdown, see exactly what the email will look like, schedule it for a time — usually days out — and let it go out on its own after you and Claude have reviewed it. It keeps your subscriber list, remembers what it sent, and preserves each issue as a permanent page.

It has one interface — an HTTP API — and two clients that use it: a **web editor** you drive by hand, and **Claude**, which drafts, edits, and helps orchestrate scheduling. There is no second way in. The editor doesn't reach past the API, and Claude doesn't do anything you couldn't do in the editor. One representation, one door, two clients — so the two can never drift out of sync, because there's only one copy of anything.

Content lives in the app's own database, with every version of a post kept as a revision. Images are uploaded to a post and referenced by name; you never touch an upload URL. Every send freezes the rendered email, and that frozen copy *is* both the reader's "view in browser" page and the permanent record of what went out.

This is a content-management application, and that's the right shape for the job. Email is not like posting a link to social — there's no platform between you and the reader, so you hold the list, the consent, the delivery, and the archive yourself. This app exists to hold exactly those things, and nothing else.

### What it isn't

- **Not your website.** It serves the newsletter's own reader surface — an archive index and the per-issue pages that are the record of what it sent — and nothing more. It doesn't manage your blog and isn't a general CMS for arbitrary pages.
- **Not multi-channel.** Email only. Cross-posting the same writing to a site, RSS, Bluesky, or Mastodon is a separate concern and out of scope here. Email is complicated enough on its own to deserve a system that does just this.
- **Not a marketing automation suite.** No drip sequences, no funnels, no A/B campaigns. One post, reviewed, sent to your subscribers.

---

## 2. The model

Six nouns. The first three are content, the last three are the audience and the record.

**Post** — one newsletter issue: a Markdown body plus its metadata. It's editable while a draft, frozen once scheduled, and closed once sent. The metadata is **subject** (the email's subject line, and what names the post in the list and seeds its slug) and **slug** (the archive path). The inbox **preheader** (preview text) is derived from the start of the body at render time, not a field you set. Subject is the one field you must set to send.

**Revision** — a saved version of a post's Markdown and metadata. Every save writes one. This is the versioning that files would have given you for free, handed back deliberately.

**Image** — a file belonging to a post, referenced by name in the Markdown. The app stores it, sizes it, and resolves it to an absolute URL at render time.

**Subscriber** — an email address with a consent state: pending, confirmed, or unsubscribed. Only confirmed subscribers receive sends.

**Send** — the record of one post going out. It's created the moment a post is scheduled — holding the frozen render, the fire time, and, after delivery, who it reached and how it went. It exists before any mail leaves, which is what makes the review window possible (§6). Never rewritten once sent.

**Suppression** — an address that hard-bounced or complained and must not be mailed again until you clear it deliberately.

These six nouns are the whole domain. Their concrete tables live in `migrations/` and the routes that manipulate them in `src/app.ts` — this spec describes what they mean and guarantee, not their columns.

### One door, two clients

```
   web editor ─┐
               ├─▶  HTTP API  ─▶  database + object storage  ─▶  email
   Claude ─────┘
```

Everything below is a consequence of this picture. The editor is a client. Claude is a client. The API is the system. There is no file to edit behind its back and no admin panel that writes directly to the tables. The one authenticated authoring surface is what both the editor and Claude use; a separate set of public, token-scoped routes serves readers (subscribe, confirm, unsubscribe, the archive), and the provider's bounce and complaint webhooks come in signature-verified.

---

## 3. Invariants

Six guarantees. In a newsletter the guarantees that matter are about consent, delivery, and the record. Every mechanism in this spec upholds one of these.

**I1 — Nothing is sent without recorded consent.** Only confirmed subscribers receive a send. Confirmation is double opt-in and timestamped, so for every delivery there is a record of when that person asked to be on the list.

**I2 — Unsubscribe is immediate and final.** From the moment an unsubscribe is recorded, no further send reaches that person. It is honored on the next send with no window in which they still get one, and it is never silently reversed.

**I3 — What went out is preserved exactly.** Every send freezes its rendered HTML. The reader's "view in browser" page and the permanent record are that same frozen copy — not a re-render, which could differ. Any public chrome an archived issue carries fills reserved placeholders in that frozen copy — the same mechanism as the per-recipient unsubscribe link — and never rewrites the reviewed content.

**I4 — A post is sent at most once per send, to each person at most once.** Triggering a send is idempotent. A retry, a double-click, or a resumed send never mails anyone twice.

**I5 — A test is a real test.** The email you send yourself to check is produced by the same render path as the email that goes to the list. A clean test is a guarantee, not a lookalike.

**I6 — Nothing is delivered without a window to stop it.** Every send becomes a pending, visible, cancelable Send before any mail leaves — for as long as you scheduled, or a short buffer for an immediate send. Nothing fires the instant it's requested. This window is the review gate.

### What follows

- **The schedule is the safety.** Because a send exists as a cancelable Send before it fires, a person and Claude can prepare one unattended and still have a window to catch a mistake (I6). This is the newsletter's place where something irreversible is visible before it happens.
- **The archive is the record.** There is no separate "what did the email look like" store to build later (I3). The page a reader opens is the artifact, and it's the very copy that was reviewed.
- **Consent is data you own, and can prove.** Not a setting on a provider you'd have to trust and can't export (I1).
- **You can always resend safely.** Because a send tracks who it reached, a failed or interrupted send resumes instead of starting over (I4).

---

## 4. Authoring

You write in Markdown, in the web editor or through the API. Both do the same thing: they read and write posts and their revisions. A post needs only a **subject** and a body to start; the **slug** (auto-derived from the subject) rounds out the metadata, and the inbox **preheader** is derived from the body at render time. A post is editable only while it's a draft; scheduling locks it (§6).

Subject is deliberately the primary field. For an email that is what the reader sees in their inbox, so it is also what names the post in the editor's list and what seeds the slug — one field carrying the weight rather than a separate "title" you'd have to keep in sync with it.

### Revisions

Every save writes a new revision holding that version's Markdown and metadata. The post points at its current revision; the history is the list behind it. Markdown is small and diffs cleanly, so each revision stores the whole body rather than a delta — simpler, and there's no reconstruction step to get wrong.

This gives you a full edit history, the ability to see what changed between two versions, and — because a scheduled post's content is frozen into its Send anyway (I3) — a clear separation between "the post as it is now" and "the post as it was sent."

### Concurrent edits

One post has two clients that can write it at once — two browser tabs, and Claude editing through the same API — so the authoring API is **optimistically concurrent**, and the rule is *notify, don't clobber.*

Because each save advances `current_revision`, that id is the post's version token. A save may carry the revision it was based on — as an `If-Match` header (the app also emits the current revision as an `ETag`) or a `base_revision` body field. If that base no longer matches the post's current revision, another writer got there first, and the save is rejected with **409** carrying the newer `{ current_revision, updated_at, author }` — the stale write never lands. A save that omits a base is unchecked (last-write-wins), so a client that doesn't participate still works.

The editor participates on both ends. It sends the base on every save, so a stale save surfaces an **out-of-date notice** instead of overwriting: *Reload* discards the local edits and loads the other version, *Keep editing* keeps the local copy so the next save writes on top of the other. It also lightly polls the current revision while open — covering another browser and Claude alike, which a same-browser signal would miss — so the writer is warned *before* investing more effort, not only when they save. The notice names who changed it (the revision's author; Claude's saves show as "Claude") and re-arms only when a genuinely newer revision appears.

### Images

Adding an image is uploading it *to a post* and referencing it by name — you upload the file `cover.jpg` to the post, then write `![A stack of paperbacks on a windowsill](cover.jpg)` in the Markdown. That's the whole workflow. No endpoint hands you a URL to paste back in; the reference is just the filename, the same way you'd write it if the image sat in a folder next to the post. At render time the app resolves `cover.jpg` to the stored file's absolute URL and the right size for email. The alt text lives inside the reference, so it's never a separate step and is easy to require.

This is deliberately the one thing many systems get wrong — GitHub included, where text is API-addressable but an image is a side upload that returns an opaque URL you have to bridge yourself. Here the author manages one thing, the post, and the image is part of it.

---

## 5. Preview and the reader surface

Preview means two concrete things, and both are the same render aimed differently.

**View in browser** — a hosted page showing the post rendered as the email. Before scheduling it's a live render of the current draft; the link is how you eyeball layout without leaving your desk. Once scheduled, it shows the frozen copy that will fire.

**Send test** — the real email, rendered and delivered to an address you name, so you can see it in an actual mail client where the rendering finally counts.

There is exactly **one render path**. It turns a post into the email, and the preview, the test, and the real send all call it. That's what makes I5 hold: if the test looks right, the send is right, because they're the same code producing the same output. Email rendering is client-dependent enough that a faithful web preview isn't sufficient on its own — so the test send is the thing you trust before scheduling, and the view-in-browser page is the convenient first look.

When a post is scheduled, its render freezes (I3) and the view-in-browser page stops being a live draft render and becomes the exact copy that will fire and, afterward, the permanent archive of what was mailed.

### The public reader surface

Because the app is self-contained (§10), it serves its own reader-facing pages, not only per-issue archives. It carries the newsletter's identity — the publication name, tagline, logo, and brand color (§8) theme these pages, so the reader surface reads as *the publication*, not the tool. Three public pages, all indexable and none ever bouncing a visitor toward an admin path (§10):

The **landing page** is the front door at `/` — the one page a reader reaches by typing the bare domain. It carries the identity and a subscribe call to action, features the latest issue, lists a few recent ones, and links into the full archive. Because it is the bare-domain page, it must be public and must never link into an Access-gated path.

The **archive index** lists every sent issue, newest first, each linking to its issue page. It lives at the archive base path (§10) — the same prefix the issue pages sit under, so the list and the issues it links to share one origin and one configured path. It carries the same identity and subscribe call to action as the landing page.

An **issue page** serves that issue's frozen render (I3). When the archive lives on the app's own origin rather than inside a surrounding website, the page may add light public chrome — a masthead with the newsletter name and the publish date, a link back to the index, a subscribe prompt, and the publication's display font and background, so its headings share the editorial voice of the reader surface and it sits on the same ground — so a shared issue reads as part of a publication and not a raw forwarded email. That chrome fills reserved anchors the render leaves in the frozen copy — the same idea as the unsubscribe placeholder — so it appears only in the browser, never in a sent email (a web font can't load in an inbox anyway), and the reviewed content is served unchanged (I3). The archive URL an email carries — its "view in browser" and every shared link — is built from the configured archive origin and base path (§10), so the same render is reachable at a stable, public address forever.

---

## 6. Scheduling and sending

Sending is built around a review window, because the window is what makes it safe to prepare a send days ahead — by hand or with Claude — and let it go out unattended. **Scheduling is the main path; sending immediately is the deliberate exception.**

### Scheduling a post

Scheduling a post for a future time does three things at once: it **freezes the render** into a new Send in `scheduled` state (this frozen copy is the review artifact, exactly what will fire, and the eventual archive — one object doing all three, I3 and I6); it **soft-locks the post**, so it can't drift away from what was reviewed; and it **records the fire time**.

A post **must have a non-empty subject** to schedule or send. The subject is the one field the reader sees in their inbox, and a send is irreversible (I4), so the freeze that both scheduling and sending-now go through rejects an empty (or whitespace-only) subject with a `400` before anything is frozen — the same guard for both clients. An empty body is only warned about, not blocked. The editor also flags an empty subject as a render warning and disables its Schedule / Send-now buttons, but the freeze is the authority.

From then until it fires, the scheduled Send is **visible and cancelable** (I6). This window is the review gate. A human and Claude review it, test emails go to real inboxes, and if anything's wrong you cancel or unschedule. The intended rhythm is to schedule days ahead, so the window is generous.

### The soft-lock

A scheduled post is frozen from casual edits. To change it you **unschedule** — which cancels the pending Send and unlocks the post — then edit, re-test, and re-schedule. Editing stays easy but becomes deliberate, and it resets the review.

The guarantee that falls out: *what fires is exactly what was last reviewed and tested*, because the only way to change a scheduled post is to schedule it again, and scheduling re-freezes the render. Since no one is at the keyboard at fire time, that last approving test is the sign-off, and the lock is what stops the post drifting from it. Freezing at schedule time also makes the send immune to app deploys during the multi-day window: the render was captured up front, so a change to the renderer in between can't alter what goes out.

### Firing

A periodic sweep (below) delivers scheduled Sends whose time has come. Because the body is already frozen, firing is just delivery: it fans out to confirmed subscribers, filling in each recipient's unsubscribe link where the frozen body left a placeholder. Batching, retries, and per-recipient tracking are exactly as for an immediate send.

### Sending now

Sending immediately is the same machinery with the fire time set to now — plus a short buffer, so even an "immediate" send spends a brief moment as a visible, cancelable Send (I6). It's the exception, not the default: most sends should carry a real review window, and send-now is for the rare case you've reviewed out-of-band and want it gone.

### What a send does, when it fires

It reads its Send record, which already holds the frozen email — a second trigger for the same post finds this record and resumes rather than restarting (I4). It resolves the audience: confirmed subscribers, minus suppressions (I1). It delivers in batches, marking each recipient as it's accepted by the email provider; progress is durable, so an interrupted send resumes from where it stopped and no one is mailed twice (I4). It records outcomes as they arrive — accepted, delivered, bounced, complained — against each recipient. And it closes the Send as complete, or leaves it open and retrying if the provider is unavailable.

### The timer

The driver is a periodic **sweep** — a scheduled task that runs about once a minute, finds Sends whose fire time has passed and that haven't gone out, and delivers them.

A sweep, rather than a per-post timer set for the exact moment, for one decisive reason: the same loop that fires due sends also detects sends that *should* have fired and didn't. A fire time that slips past with no delivery is caught on the next sweep and raised loudly — a dropped send is as bad as an accidental one (§11). A precise per-object alarm would give you precision a newsletter doesn't need and no built-in way to notice a timer that silently never fired; you'd end up adding a sweep anyway as a backstop. One reconciling loop is simpler and safer than precise timers plus a watchdog, and it tolerates an occasional slow tick by design.

### Made to just work

"Just works" here means a clean conceptual model and quiet, sensible recovery — not cleverness you have to babysit. Transient failures retry automatically, with backoff, until they clear. Hard bounces and complaints suppress the address on their own, from the provider's webhooks, so a bad address fixes itself for next time. A send that can't finish keeps trying and tells you only once it's genuinely stuck — a provider outage, not a blip; silence means it's working. A scheduled send that fails to fire is loud, not silent (§11). And you can always see exactly what's going out, because the render is frozen and the per-recipient state is recorded — confidence comes from being able to look, not from hoping.

The one thing the app will not do quietly is send to someone it shouldn't, or send something no one saw. Every automatic behavior above is about delivering reliably or not delivering to the wrong people; none of it ever widens the audience or skips the window on its own.

---

## 7. Subscribers and consent

A subscriber is an email address with a **consent state**, plus an orthogonal **suppression** flag for deliverability. The consent state is the whole story of whether someone has asked to be on the list; suppression is a separate "this address can't or shouldn't be delivered to" mark.

| State | Meaning | In the send audience? |
| --- | --- | --- |
| **Pending** | Subscribed but hasn't clicked the confirmation link yet | No |
| **Confirmed** | Completed double opt-in; consent is recorded and timestamped | Yes — unless suppressed |
| **Unsubscribed** | Left the list (their own unsubscribe, or the operator on their behalf) | No |

**Suppressed** is not a consent state but a flag that can sit on top of one: an address that bounced hard or drew a complaint is excluded from every send whatever its consent state (I1). So a subscriber can be *confirmed and suppressed* at once — consented, but still never mailed. The audience for any send is exactly *confirmed minus suppressed*.

### Joining

Someone subscribes through a public form, which creates a **pending** subscriber and sends a confirmation email. Clicking the link **confirms** them (double opt-in). Only confirmed subscribers are ever mailed (I1). Double opt-in is a deliberate cost: it's the record that consent was given, it keeps the list clean, and it protects sending reputation.

### Leaving

Every email carries an unsubscribe link and the one-click header that bulk mail now requires, so a subscriber can leave from the message itself with no login and no confirmation step. Unsubscribing is immediate and final (I2). The operator can also unsubscribe someone from the admin subscriber list — the same immediate, idempotent effect (I2) — for a request that arrives out of band; it never auto-confirms anyone, only removes consent.

### Two tokens, two jobs

A subscriber carries two independent unguessable tokens, one per job. The **confirm token** drives double opt-in and is one-shot: it is rotated every time a pending or unsubscribed address re-subscribes, so a stale confirmation link can't be replayed (its single-use property comes from confirmation only acting on a *pending* row, not from consuming the token). The **unsubscribe token** is durable — minted once and never rotated, not even across an unsubscribe→resubscribe cycle — because it is the token embedded in the one-click unsubscribe link of every issue already delivered. Keeping them separate is what lets that link keep working forever (I2): a returning subscriber can still leave from mail that has been in their inbox since before they last left, which a single rotated-on-resubscribe token would silently break. Neither token can do the other's job — a confirm token can't unsubscribe, and an unsubscribe token can't confirm.

Consent withdrawn (unsubscribe) and undeliverable (suppression) are different states with different owners:

| State | Meaning | Who sets it | Who clears it |
| --- | --- | --- | --- |
| Unsubscribed | Consent was withdrawn | The reader, or the operator on their behalf | The reader, by re-subscribing |
| Suppressed | Bounced hard or complained | The app, from provider signals | You, deliberately, rarely |

### Later, not now

Topics and segmentation — letting people subscribe to some kinds of post and not others — are a real feature and a deliberate v2. They add a preference center and turn "the audience" into "the audience matching this post's topics." The model is built so this slots in as a filter applied when a Send resolves its audience, plus a few columns on the subscriber, without disturbing anything above.

---

## 8. Seeing what's happening

A small status surface, readable in the editor and through the API, answers the questions you'll actually have.

**What's scheduled, and when does it fire?** The pending Sends, each with its fire time and its frozen render, and a one-call cancel. This view is what makes the review window real — a window you can't see into or act on isn't one (I6).

**What have I sent, and how did it do?** Recent sends, each with its recipient count and a rollup of delivered / bounced / complained, linking to the archive page for that issue.

**Is anything wrong right now?** A send still retrying, a scheduled send that missed its fire time, a bounce spike, a provider problem. This is the only thing that ever needs your attention, so it's the only thing that surfaces loudly.

**Who's on the list?** The subscriber list is its own view, distinct from send health: it tells the story of the list as a whole rather than of a particular send. It shows the roster — each address, its consent state, and whether it's suppressed — filterable by state and searchable by address, with the list's composition (counts by state: pending, confirmed, unsubscribed, suppressed) at the top. From here you can add a subscriber, which starts the same double opt-in and never auto-confirms, or unsubscribe one (I2). The send-status surface above keeps only scheduling and delivery, so each view answers one question cleanly.

**How is it configured?** A settings surface holds the app's own runtime preferences — the ones with no home in a post or a subscriber, like the default recipients the test-send flow pre-fills and the **publication identity** (name, tagline, logo, brand color) that themes the public reader surface and the author's dashboard. That identity is web chrome only: it never touches the email, whose identity is the `From:` header, and never a frozen record (I3) — the logo is a single global asset stored under a reserved media key and served like any other image. It is read and written through the same authenticated API as everything else (one door, two clients), so Claude and the editor configure the app the same way. Configuration splits along one hard line: this surface holds **preferences and never secrets**. The provider choice, its credentials, the access configuration, and the origins are deploy-time infrastructure that lives in the environment and its secrets (documented in the operator setup guide), never in the database and never readable or writable through the admin API — so a compromised admin session can change a preference but can never reach a credential. For orientation the surface *shows* the deploy-time configuration read-only, next to a link to the guide that explains how to change it.

The record is the source of truth for "did it go," because the app is the only thing that knows what actually happened at delivery time.

---

## 9. What email demands

Email asks for things the other channels never would, and this is what the system takes on so a send lands instead of bouncing or going to spam.

**Authentication.** SPF, DKIM, and DMARC on the sending domain (§10). Without them a bulk sender lands in spam or is rejected outright.

**List headers.** `List-Unsubscribe` and `List-Unsubscribe-Post` on every message, so the one-click unsubscribe works from the inbox UI — required by bulk-sender rules. They're set per recipient, pointing at the token-scoped unsubscribe endpoints.

**A plain-text alternative.** Every HTML email ships a text part.

**Batching and idempotency.** Provider send endpoints take tens to a hundred recipients per call, so a send is a loop of batches. No one is mailed twice on a retry because the app records each recipient the instant the provider accepts them, and a resumed or retried batch simply skips those already accepted (I4). A provider-native idempotency key, where it exists, is an extra guard — never the thing the guarantee rests on.

**Bounce and complaint handling.** Provider webhooks feed suppression: soft bounces are tolerated and counted; a hard bounce or a complaint suppresses the address on its own.

The email provider is treated as **transport** — it carries the message and reports what happened — and it sits behind a narrow, two-method seam: one method sends a batch and returns a per-recipient accept/reject; the other verifies a provider webhook's signature and normalizes it into a delivered / bounced / complained event. Everything provider-specific lives inside the adapter. The two supported providers differ most at the webhook: one posts a signed webhook directly, while the other routes events through a notification service that adds a subscription-confirmation handshake and its own signature scheme. Hold the seam at the *intersection* of what providers offer — the app owns the list, the consent, the deliveries, and the suppressions itself, so it never leans on a provider's managed suppression or list-hosting. That's what makes swapping providers a swap and not a migration, and it's why a fake in-memory adapter behind the same seam can exercise the whole send-and-resume path with no network.

---

## 10. Domains and deployment

The app is **self-contained by default**: it serves its own reader surface — the landing page, archive index, and per-issue pages — on its own origin, and makes no assumption about where, or whether, you run a separate website. Putting the archive under your main site's domain is a real benefit, but a Cloudflare-specific **enhancement you opt into**, not a step required to finish setup.

### The self-contained default

One deployed service answers on one hostname — `newsletter.example.com` — and does everything: the admin editor and authoring API, the public reader surface (landing page, archive index, issue pages, subscribe/confirm/unsubscribe), previews, and image bytes. The archive origin defaults to the app's own origin, so every "view in browser" link and archive URL points at `newsletter.example.com/archive/{slug}`. The only Cloudflare dependency is the app's own subdomain — unavoidable, because the app *is* a Worker. A newsletter works end to end no matter where your marketing site lives, or if you have one.

Two names still earn their own DNS, because they have genuinely different jobs — and the names themselves should say so, unmistakably. The **app and reader surface** live on `newsletter.example.com` — its own name so its uptime is independent of anything else. The **sending identity** lives on `send.example.com` — the From address and its SPF/DKIM/DMARC, off the apex so newsletter reputation can't affect your regular mail. `newsletter.` names the *app*; `send.` names the *mail* — deliberately not near-synonyms, so the two can't be confused or swapped. Avoid `mail.`, which the world treats as an inbound MX host, not a sending identity. **Never send bulk mail from the apex; that's the one rule here that isn't a preference.**

### Optional: surface the archive on your website's apex

If your website is on Cloudflare, you can additionally present the archive under your main domain — `example.com/archive/*` — so links carry your primary domain's trust, rank with the rest of your site, and never read as an unfamiliar host in an email footer. Archive URLs are permanent (I3); anchoring them to your most durable name, rather than the app's operational subdomain, is the real prize.

This is a routing concern on the apex zone, not a second app: add `example.com/archive/*` as a route to the *same* Worker (most-specific route wins; the static site keeps everything else), and set the archive origin to the apex so emitted links use it. Because the archive base path drives both URL generation and the route that serves it, you can pick a path that doesn't collide with an existing page on your site.

If your site is **not** on Cloudflare, you can't attach a Worker route to a zone Cloudflare doesn't control, so the honest options are a **reverse proxy** from your host that forwards `/archive/*` to the app, or a **redirect** — trivial to set up, but one that sends the reader's address bar back to the app host and so forfeits the apex benefit. When neither fits, stay self-contained — the archive on `newsletter.example.com` is a first-class home, not a fallback.

### Admin and public on one host

Self-containment puts two audiences on one name, so the access boundary is the product's spine. **Admin** — the editor and the authoring API — sits behind real authentication (an edge access layer, so you write no auth code). **Public** — the landing page, archive index, issue pages, subscribe / confirm / unsubscribe, and media — is deliberately open, protected where it must be by unguessable per-subscriber tokens, because a reader clicking unsubscribe from their inbox has no account to log in with.

The admin surface also carries the **operator setup guide** — the deploy-and-operate documentation, rendered read-only inside the editor from its Markdown source in the repository (which stays the single source of truth; the pages are not editable in the app). It is a Markdown→web-page view, distinct from the single Markdown→email render path (I5), and it is fetched by the editor and gated with the rest of admin — never a top-level navigation, which would carry no credential.

It also carries an **API reference**, generated from the route registration itself. Claude is a first-class client of this API, so a reference that is always current is part of keeping the door self-describing. Every route is declared as data — method, path, access tier, summary — in one manifest; that manifest both registers the routes and renders the reference, the same one-source discipline as the archive base path driving both the emitted URL and the route that serves it. So the documented tier and the enforced gate are the same field and cannot disagree, and a new route appears in the reference with nothing else to edit. This is *why* this spec carries no endpoint table: an earlier draft had one, it drifted from the real routes, and the fix was to generate the reference from the code rather than restate it here. Like the setup guide, it is a read-only, same-origin authed fetch shown inside the editor — never a top-level navigation.

One rule falls out and is easy to get wrong: **no public entry point may redirect or link into an Access-gated path.** The public front door — `/` — is the landing page, served to everyone; it must never bounce a visitor to the admin editor, which is an Access login wall. Express the public surface as one explicit allowlist of path prefixes; everything else is admin.

The access layer must also admit a non-interactive principal — a service credential for Claude, distinct from the interactive human login — without weakening the human gate. That such a credential exists is the requirement; how it's issued is the implementor's call. As defense in depth the app also re-verifies the access assertion itself, so a misconfigured edge policy can't silently expose admin routes.

There is **one identity contract**: the app verifies a signed token and resolves a `Principal` — a `human` (carries an email) or a `service` (Claude / automation, no email). Everything upstream normalizes to this. In deployed environments Cloudflare Access issues the token for both principals: a human SSO login, and a **service token** for Claude — the latter is Claude's API credential (e.g. carried by a Claude Desktop connector), no separate token system needed. In local development there is no edge, so the app verifies a token signed with a dev secret instead — the same contract, a different key — enabled only in a dev-shaped environment (fake transport, no Access configured) and structurally inert once deployed. The interactive client (the editor) reflects the resolved identity and offers a sign-out; it never prompts for a credential in the Access-gated deployment. (An agent-native alternative — Cloudflare Managed OAuth for Access, where Claude authenticates *as the operator* rather than via a service token — is a deferred enhancement that slots into this same contract; it would replace the "distinct service principal" above and is tracked separately, not yet adopted.)

### Environments

Three environments, each with its own database, its own storage, and — the load-bearing rule — its own mail transport, so development can never reach a real inbox.

| | Database | Email transport | Access |
| --- | --- | --- | --- |
| Development (local) | Local, disposable | Dead-end: the fake in-memory adapter | localhost only |
| Staging (deployed) | Separate | Provider sandbox / test domain → only addresses you own | Behind access control |
| Production (deployed) | Real | Real provider, real sending domain | Behind access control |

Staging exists because email's real failure modes — DKIM alignment, inbox rendering, the bounce webhook round-trip, one-click unsubscribe in a real client — only appear once deployed, and a real test send to yourself is the only way to prove them before a real send to subscribers.

The app is allowed to be a living application — that was the whole point of separating it from any static site — so it can hold state, run its sweep, and retry work. The intent is to keep it small and well-defined, not elaborate. The concrete instantiation of these roles for this project is in the *deployment appendix*.

---

## 11. Failure posture

The posture is: recover quietly, escalate rarely, always be inspectable.

Send-time transient errors — a rate limit, a brief provider hiccup — retry with backoff inside the send, per batch. The retry is safe because it is scoped by what the delivery record already marks as accepted: a recipient marked accepted is never re-sent, so idempotency comes from durable per-recipient state, not from the provider. An interrupted send — the service restarts mid-send — resumes from that same progress, mailing only those not yet accepted (I4). A provider outage keeps the Send open and retrying, and surfaces on the status view only once it has clearly stopped being transient. Bounces and complaints arrive by webhook after the send and update the delivery and suppression records on their own.

The one failure that is raised loudly rather than absorbed is a scheduled send that misses its fire time. A send that should have happened and didn't is as bad as one that shouldn't have and did — precisely because nothing happened and no one was watching — so the sweep that fires due sends also catches missed ones and escalates. The schedule lives as durable rows, so a restart or redeploy can't lose it; the sweep simply re-reads and continues.

Nothing here retries in a way that could re-mail a person, because every retry is scoped by what the delivery record already marks as accepted. And nothing is hidden: the frozen render plus per-recipient state means "what happened" is always a query, never a guess. That inspectability is what gives you confidence things are working — the goal set for this app — without making you watch it.

---

# Appendix — decisions and deferred

## Decided

- **The app owns content, in a database.** Chosen over Markdown files in a repo. It buys a build-free live preview, images uploaded rather than committed, and a single door so the editor and Claude can't drift. It costs casual `git`-versioning, which the revision table hands back deliberately.
- **One interface, two clients.** No file-editing path beside the API. This removes the whole class of "did the file and the record disagree" bugs, and it's what makes Claude-in-production safe: the same door you use, with the same review window in front of every send.
- **Self-contained by default, apex-optional.** The app serves its own reader surface on its own origin, so a working newsletter never depends on where the website is hosted. Surfacing the archive on the website's apex is an opt-in enhancement for sites already on Cloudflare, chosen over making it the required shape — which would have welded the finished product to the website's infra and turned "hook it up to your site" into a wall for anyone not on Cloudflare.
- **Subject is the primary post field.** For an email the subject is what the reader sees, so it is also the list name and the slug source; a separate "title" would only be a second field to keep in sync, so there isn't one. The inbox preheader is derived from the body rather than authored, for the same reason.
- **Scheduling is core, not deferred.** The review window between scheduling and firing is the safety model — it protects against any bad send, a person's as much as an agent's — so it's v1, not a later feature. Send-now is the narrow exception, and it still carries a short cancelable buffer.
- **Soft-lock over the rigid alternatives.** Scheduling freezes the render and locks the post; editing means unschedule, edit, re-test, re-schedule. This keeps "what fires equals what was reviewed" true without making edits painful, and is chosen over both "fire the current version" (which could send something untested) and "fire the scheduled version but allow edits" (which breaks the guarantee).
- **A reconciling sweep drives the timer, not per-post alarms.** The sweep both fires due sends and detects ones that should have fired and didn't, so the loud-failure requirement is inherent rather than bolted on. Per-object alarms would add precision a newsletter doesn't need and still require a sweep as a backstop.
- **Full-text revisions.** Markdown is small and diffs well, so every version is stored whole. No delta chain to reconstruct.
- **The archive page is the record.** The "view in browser" link and the I3 artifact are the same frozen HTML, so there is no separate email-archive to build later.
- **Email only.** Site, RSS, and social are a different system. This one does the hard channel well.
- **Default to SES, behind a swappable provider seam.** SES is the default transport — already warmed behind the existing Sendy install, cheaper, and no second sending reputation to grow — reached through the two-method adapter (§9) so Resend or another provider drops in without touching the app. The list, consent, and record stay in this app's database, which is what makes it a swap and not a migration.

## Deferred

- **Topics and segmentation.** A preference center and a filter applied when a Send resolves its audience. Built toward, not built yet.
- **Open/click analytics.** The delivery record can carry it; not needed to send well.
- **A `git` mirror of content.** If edit-in-my-own-editor is ever missed, the database can export Markdown to a repo for versioning and offline editing, without moving the source of truth back out of the app.

## Open

- **How much of the reader-facing unsubscribe/preferences flow to host yourself versus lean on the provider.** Consent and preferences are yours to own; deliverability suppression can lean on the provider. The split is a judgment call to make when the provider is chosen. (With SES as the default, the app hosts the unsubscribe token flow itself; SES's account-level suppression list stays a redundant safety net under the app's own suppressions.)
- **How much public chrome an archive issue page carries.** A self-contained archive can add a masthead (newsletter name, publish date, a link back to the index) and a subscribe prompt (§5); how far that goes toward a full publication home versus a thin frame is a design call, bounded only by I3 — the chrome fills reserved anchors and never rewrites the reviewed content.

---

# Appendix — deployment

The portable §10 above, instantiated for this project. This is the one project-specific section; the rest of the spec stays provider- and platform-neutral.

- **Its own repo and deployment**, separate from the static site, so deploy cadence, uptime, and blast radius are independent — a newsletter fix doesn't rebuild the whole site, and a site-build break doesn't block a send-retry deploy.
- **Cloudflare Worker** over **D1** (the database) and **R2** (images), with a **Cron Trigger** driving the send sweep. Cron granularity is one minute, which matches the §6 sweep; a Durable Object alarm is the alternative, but the reconciling-sweep choice maps directly onto Cron.
- **SES is already the transport**, warmed and out of the sandbox behind the current Sendy install; this app **replaces Sendy**. Reuse or add a sending identity for the `news.` role (§10) on that SES account. Bounce and complaint events arrive via SNS.
- **Archive self-contained by default.** The archive origin defaults to the app's own origin, so `newsletter.example.com/archive/{slug}` is the archive URL out of the box, and the public landing page at `/` is served by the same Worker. The editor is static assets under `/dashboard/`.
- **Optional apex archive.** If the apex is on Cloudflare, add `example.com/archive/*` as a route to the newsletter Worker on the apex zone (the most-specific route wins) and point the archive origin at the apex, while the static site keeps everything else. This is the enhancement, not the default.
- **Access.** Admin/authoring sits behind the platform access layer (with a service token for Claude, per §10's access rule); the reader routes — the landing page, archive index, issue pages, subscribe, confirm, unsubscribe, media — are public, guarded by unguessable per-subscriber tokens. The public landing page is the front door at `/`; it is served to everyone and never redirects into the Access-gated admin surface.
- **The concrete deploy-and-operate steps** — provisioning, the one Access application, connecting SES/Resend and its webhook, sending-domain DNS, wiring the archive to a website, and the verify checklist — are the operator setup guide under `docs/setup/`, which is also the in-app admin docs surface (§10). This spec holds the *why*; that guide holds the *how*.
