# Kestrel design

How the admin UI presents what Kestrel does. `docs/SPEC.md` says what the system guarantees and how it behaves; this document says which screen, control, color, and words show that behavior to the publisher. Where the two meet, the spec decides the behavior and this document decides the presentation, and neither restates the other.

**Who it's for.** Anyone about to change the editor, or trying to understand why it looks the way it does: a person or a Claude agent adding a screen, a control, a message, or a color.

**How to read it.** The principles (§1) are the reasons; most rules later in the document follow from one of them. §2 is a map of the app, §3 walks each screen, and §4 follows a send across all of them. §5 to §11 are the shared vocabulary every screen is built from: where messages go, how saving works, the button roles, color, layout, copy, and accessibility. §12 lists what was left out on purpose, and §13 is a checklist for a change.

**What it doesn't hold.** Exact CSS lives in `public/dashboard/styles.css` and behavior in `client/`; this document names what each piece means and which one to reach for, one level above the declarations. How the SPA is mounted is `.claude/rules/client.md`, and how it is built is `.claude/rules/client-build.md`.

**Keeping it true.** A change to how the UI presents something updates this document in the same commit. When this document and the code disagree, one of them is a bug: flag it rather than quietly editing either to match.

---

## 1. Principles

Kestrel is one publication, written by one person, through two clients (this editor and Claude) over one API, and its sends can't be taken back (SPEC §1). Each principle below follows from that.

**1.1 The review window is always in view.** Every send exists as a visible, cancelable send before any mail leaves (I6), and a window no one can see into is not a review. Wherever a scheduled send appears, it shows its fire time and a countdown, and the controls that act on the window (Edit schedule, Cancel) appear for exactly as long as the server would accept them. Scheduling is the main path; sending now is a demoted choice inside the Schedule dialog.

**1.2 The server decides; the page shows.** What is wrong with a send, what can be done to it, and how often to look again are the server's answers (SPEC §8, `docs/API.md`). A page never derives a condition, a threshold, or whether a control would work. A control appears when the send's actions offer it, and a problem appears in the server's own words. Claude reads the same answers, so the two clients can't disagree. The one rule a page applies on its own clock is taking a scheduled send's window controls away at its fire time.

**1.3 Quiet unless someone must act.** Most of the time nothing is wrong, and the UI says nothing about it: no "all systems normal" banner, no green checks on healthy sends. The few conditions the spec names (a missed fire time, a wedged send, a refusing provider, a send in flight too long, a bounce spike, no provider connected) are the only things that surface loudly, and they stay in view until they clear.

**1.4 What you preview is what sends.** The preview, the test, and the send share one render path (I5), so the UI presents the preview as the email itself and the test as the thing to trust. Once a post is scheduled, every view of it shows the frozen copy (I3). Anything that is not the render path, such as the Template page's sample, is labelled as a sample and points to the test.

**1.5 Never lose words without saying so.** A draft autosaves, and a save that would overwrite another writer's newer version stops and asks instead (SPEC §4). Leaving the editor saves in the background; a leave that could lose words asks first.

**1.6 Explain in place, and point to the way out.** A refusal or a lock is explained where the publisher meets it: the empty subject under the Subject field, "Cancel the schedule to edit" on the locked composer, the not-connected line inside the dialog it disables. A message that only says "no" is incomplete; it names the next step.

**1.7 Deploy facts are shown, never edited.** The provider, the sender, the origins, and the notification channel are deployment configuration (SPEC §9). The UI shows them read-only, beside the guide that changes them, and never offers a field for them.

**1.8 A small vocabulary, used the same way everywhere.** One class per button role, one home per kind of message, one meaning per color, one word per concept. A new treatment is a smell: reach for an existing one first, and if none fits, change this document in the same commit as the code.

---

## 2. The app at a glance

### What this covers

The **admin UI**: the editor and authoring screens behind auth, at `/dashboard`. The reader surface (the landing page, the archive, post pages, and the subscribe, confirm, and unsubscribe pages) belongs to SPEC §5 and §11 and is not styled from these tokens.

Two pieces of the app's own chrome do appear on reader pages, and only the publisher ever sees them: the dev-only **Open dashboard** pill on a local instance (SPEC §5), and the strip across the top of a test's unsubscribe pages, saying they only show what a subscriber would see (SPEC §7). Both are the app speaking to the publisher, not the publication, so they wear the brand accent rather than the reader's ink. The strip runs the window's full width above the publication's masthead, so the masthead beneath it is exactly the one a reader gets.

### The shell

A sidebar sits beside the routed view:

- **Brand** at the top: the publication's logo, name, and tagline, linking to the Dashboard, then **View publication ↗**.
- **Navigation**, one flat list: Dashboard, Drafts, Sent, Subscribers, Template, Settings.
- **Foot**: who is signed in (or "Local dev"), the Kestrel mark that opens Docs, and the collapse control.

The sidebar is full width on a wide window, an icon rail on a mid-size one, and a drawer below 540px. The collapse control overrides full or rail for the current page load only, so a reload always starts from the width-based default.

The editor, the web version, the docs, and the walls hide the sidebar: writing wants the full width, the web version is a page of its own, the docs are about Kestrel rather than the publication, and a wall stands alone.

### Screens

| Screen | Route | What it answers |
| --- | --- | --- |
| Dashboard | `#/dashboard` | Is anything wrong, who is on the list, what's scheduled, what went out. |
| Drafts | `#/drafts` | What am I writing. Drafts and scheduled posts. |
| Editor | `#/edit/:post` | Write, preview, test, and schedule a post; review a scheduled one. |
| Web version | `#/web/post/:post` | How the post's public page will look, before it is public. |
| Sent | `#/sent` | What needs attention, what's queued, what's going out, what went out. |
| Send page | `#/sent/:send` | How one send is going (the watch) or went (the record). |
| Subscribers | `#/subscribers` | Who is on the list, in what state, and how they joined. |
| Import subscribers | `#/subscribers/import` | What bringing a list in would do, before it does it. |
| Template | `#/template` | The one email template every post is sent in. |
| Settings | `#/settings` | The publication's preferences, and the deploy facts read-only. |
| Docs and API | `#/docs`, `#/reference` | The docs, as two sets (Publishing and Self-hosting), and the API reference, served by the instance. |

The admin UI may link out to public pages (View publication, Archive ↗, View published post ↗). No public page links or redirects into `/dashboard` (SPEC §11), apart from the dev-only pill above.

### Where a post lives

SPEC §8 splits the publisher's world into a writing side and a dispatch side, and a post's send, not the post, decides which side it is on. The routing enforces the split, so an editable-looking page is never shown for something that can no longer be edited.

| The post's send | Opens at | Shown as |
| --- | --- | --- |
| none, or canceled | Editor | an editable draft |
| scheduled | Editor | locked, with the scheduled banner |
| sending | Send page | the live watch |
| sent | Send page | the record |

A page that finds its subject has moved on (an editor link to a post now sending) hands off and replaces its history entry, so Back returns to where the publisher came from. A hand-off the publisher didn't cause, such as a send starting while the editor is open, is announced with a toast saying why the page changed.

### Walls

Four states replace the whole app with one card, because no screen could do anything useful behind them. Each tears down the mounted view so nothing keeps calling, hides the publication's chrome, and moves focus to its heading.

- **The configuration is refused** (SPEC §9). Every call fails the same way, so the wall says a setting needs fixing and nothing is sent until it is, gives the server's own words about what's wrong, and links that setting in the published configuration reference (the in-app docs are behind the same refusal). How to fix a setting is the reference's to say, so the wall can't drift from it. One control, **Reload** (Primary), since the fix happens outside the app. It carries `role="alert"`.
- **The database needs updating** (SPEC §9): the database hasn't run every migration the release ships. The same wall as a refused configuration, with the server's words naming the missing migrations and what to run, and no reference link, since no setting is wrong. The server gives this refusal before it looks at who is asking, so it shows ahead of the walls below.
- **The editor is locked until Access is set up** (SPEC §11). There was never a session, so signing in again can't help. The wall says the editor is locked until Access is in front of it, that this is expected on a new deployment and the public pages work, and links the Access guide on the project's site. One control, **Reload**. It carries no `role="alert"`, since it is an expected state; focus moving to the heading announces it.
- **The session has expired.** One control, **Sign in** (Primary), which reloads to start a fresh sign-in.

A wall is drawn once, however many calls fail, and can't be dismissed: there is nothing behind it to return to. Links out of a wall open the project's site in a new tab, since the editor's own Docs tab sits behind the same failure.

### Dialogs and menus belong to their page

Leaving a page, by Back, a link, or a changed URL, closes any dialog or menu it left open, so neither ever sits over a page it wasn't opened for, where its confirm would act on something no longer on screen. Only the surface goes: a write already started from it still lands, and its toast still says so. A save left waiting on a re-make confirmation (§4) is not made, since nobody confirmed it, and a toast on the next page says it wasn't saved.

---

## 3. Screens

Each screen below is described top to bottom, then its own rules.

### Dashboard

The landing page, ordered by urgency:

1. **Head**: the publication's name and tagline, and **New post** (Primary).
2. **Health block**, only when something needs attention (§4).
3. **Finish setting up**, until the first post listed in the archive is published (below).
4. **Active sends**: a card per send in flight, with a small dispatch bar and counts, linking to its watch.
5. **Subscribers**: four count tiles (Confirmed, Pending, Unsubscribed, Suppressed), each a link into Subscribers filtered to that state.
6. **Scheduled** and **Drafts**, side by side. A scheduled card shows its countdown and opens the editor; it carries no Cancel, since the schedule is managed in the editor and on the Sent page. A send whose look changed since its last test says so on its card (§4), and an email-only post says so in its line (§4). The Drafts card marks an email-only draft with the Email only mark after its title (§3, Sent posts), and keeps its date on one line.
7. **Sent**: the latest five sends that have started, with Delivered (§8) and **Archive ↗**, the post's page. An email-only post (SPEC §5) carries the Email only mark after its subject, and its link reads **Web version ↗** and opens its unlisted link, since it has no archive page.
8. **Quick actions**, **Publication** (the home page's address with Copy, and **View publication ↗**; the archive and every post are a click from there), and **API access**, which invites the publisher to connect Claude or says Claude is connected.

**First run.** Until the first post, the body is a setup checklist, **Set up your publication**, instead of a wall of zero tiles: name the publication; connect a provider, or once one is connected, check the setup, opening the publisher's page on testing and on how Kestrel reports problems; bring an existing list; publish the first post; share the subscribe link. Sending comes late because a first post ends the first-run page, and a step left below it would only be seen on the card. The Publishing docs' section of the same name follows these steps.

**Finish setting up.** Once a post exists the regular dashboard shows, and the same steps stay reachable as a compact **Finish setting up** card under the health block, until the first post listed in the archive is published (its send has started, the moment the public archive first shows a post). **Publish your first post** is the step that ends setup (its hint: "Write a post, test it, and send it. It goes to your subscribers and onto your site."), so its check and the card clearing are one moment, and the card never shows every step done while still waiting. An email-only post, such as Verify it works' test send, doesn't end it, so the publisher still gets the guided start after the operator has verified the instance. The checklist and the card are one component in two layouts, so their steps can't drift apart. A step reads as done, with a check, only from what the app knows, and nothing is ticked by hand or dismissed: the name once one is set in Settings, and the list once it has subscribers, with the count of confirmed and pending. Checking the setup and sharing the link are guidance and never read as done: a send the operator made to verify the instance says nothing about whether the publisher checked theirs, and sharing can't be known. Neither holds the card open. Steps can be taken in any order, each keeping its button; on the card, New post is Ghost, since the head's is the view's Primary. While the card carries **Connect Amazon SES**, the health block leaves out its amber not-connected line, so the state is said once; a send held for want of a provider is still the health block's red line.

### Drafts

The writing side: drafts and scheduled posts. A sent post is a record and lives under Sent. The list has search, a Draft or Scheduled filter, sortable columns, and paging. An email-only post carries the Email only mark after its title, as in Sent; a listed one carries nothing. A row opens the editor; a post whose send is in flight shows the `sending` badge and opens its watch instead. The row menu (⋯) offers Open (Watch send, for a post in flight), and Delete draft for a draft, which confirms in a dialog that says the revisions go too and it can't be undone.

### Editor

The editor opens only a draft or a scheduled post (§2), and carries no status pill: the editable layout says draft, and the scheduled banner says scheduled. Opening a post that isn't there toasts that it was deleted and goes to Drafts, rather than showing an error whose Retry can only fail. The subject, the composer, and the actions bar sit on the page itself, with no card around them: the fields and the composer carry their own borders, so a card would only frame frames, and the page lines up with its head and banner. Top to bottom:

- **Head**: ← Drafts on the left. On the right, on a draft, the **Email only** mark (an envelope and muted words, as in the lists) while it is left out of the archive (only the exception is marked; a scheduled post's banner says where it is going instead), **Web version ↗**, and, rightmost, **⚙ Post settings** (Ghost), which opens the post's settings (below). It sits beside Web version because the one shows the public page and the other changes it, and it stays put whether the post is a draft or scheduled. Its words say "Post settings", not "Settings", since the sidebar's Settings is the app's own.
- **Scheduled banner**, for a scheduled post (§4).
- **Conflict banner**, when another writer has saved (§5).
- **Subject**, full width, with nothing under it: where the post will go is in Post settings and the Schedule dialog, and, once it is scheduled, in its banner.
- **Composer**: **Edit | Preview** tabs, a formatting toolbar, the Markdown, and a foot that takes images ("Paste, drop, or click to add images"). An image is uploaded to the post and referenced by name, never as a URL (SPEC §4).
- **Actions bar**: **Save draft** with the save cue beside it, **Send test email** (Secondary), and **Schedule** (Primary).

**Scheduling.** Schedule opens a dialog that explains the window, offers a time no earlier than the minimum lead, and confirms with Schedule. A time inside the lead is refused under the picker, in words that say why ("Pick a time at least 5 minutes from now, so there’s time to cancel."). They are the server's words, shown as they arrive when the server's clock catches it, and the editor's own check before asking says the same; Edit schedule's refusal reads the same. Beneath, "Or send as soon as possible." and **Send now →**, a text link, not a button: sending without a chosen time is the lesser path, and a button would sit level with Cancel and undo the demotion. The row says what Send now is for, never that it skips the window, which it never does (I6). The **Send now** view it opens is where the lead is explained, before anything is sent: "Sends this draft, as it is now, to 155 recipients in 5 to 6 minutes. The post locks until then, and you can cancel any time before it starts sending." The range is the lead plus the rounding up to the next minute, the count is who the send will reach (confirmed, less suppressed), and its copy never implies instant delivery. Both views use the deployment's own lead. Under the time (in Send now, under its line) is the same form as **Post settings** (below), showing the post's settings as they stand, so a publisher who decides at send time can change them there. The ticked **Include in archive** states the default, so the line above it doesn't repeat where the post will go. The dialog edits its own copy: a change reaches the post only when Schedule or Send now is pressed, and Cancel leaves the post as it was. The copy carries over between the two views. **← Back to schedule** returns from the Send now view, a text link at the start of its button row, so it takes no row of its own. After scheduling, the publisher stays on the post, now locked, with a toast naming the fire time and "Send yourself a test", because the window is the review and this page is where it happens.

**Post settings.** A dialog with two settings, neither part of the email, and the same form wherever the settings show (Post settings, Schedule, Send now, Edit schedule, and, without its first box, Add to archive):

- **Include in archive**, checked by default, with the helper "Listed on your home page and in your public archive. Unchecked, it’s sent as email only: anyone with the email can still open its web version." Unchecked, the rest of the form goes, since an email-only post has no archive address.
- **Archive address**: one URL field on one background, its base in grey text and fixed, then the slug, the one part to type. The whole field is the label, so a click on the base lands in the slug, and focusing it selects the slug to type over. While the slug follows the subject, a line under it says so ("Follows the subject until you type your own."); typing takes it by hand, and leaving it empty hands it back to the subject. When another post holds the subject's slug, the post takes the next number and the line says why, in grey beside an info icon, since nothing needs fixing ("Another post has `spring-update`, so a number was added. You can change it above."). A slug the server refuses, malformed or another post's, is said in its words under the field, which turns red, and the dialog stays open with focus in the field. Once the post is sent its address is fixed, so Add to archive shows it read-only, the whole field greyed.

Cancel and Save (Primary): nothing is saved until Save, and Cancel, Escape, or a click outside leaves the post as it was.

**A post with no subject.** Schedule stays enabled, and pressing it marks the Subject field with "Add a subject before you schedule" and moves focus there; the error clears as soon as a subject is typed. A disabled button would refuse without a reason. Send now is inside the same dialog, so the same check guards it. This check is a courtesy; the freeze is the authority (SPEC §6).

**A scheduled post.** The lock is presented without hiding the content, and without locking what isn't part of the email:

- The subject reads as locked: read-only rather than disabled, so it can still be selected and copied and a keystroke still pulses the foot line, but styled to look locked, with the recessed surface, muted text, an arrow cursor, and a grey focus ring in place of the blue one. The body's text is muted the same way, and focus rings the whole composer in the same grey. The banner names where the post is going. **Post settings** still opens and saves, since neither setting is part of the email.

- It opens on **Preview**, since the preview is the copy that will send. The Edit tab is somewhere the publisher goes on purpose.
- On Edit, the text stays legible, selectable, and copyable on a recessed surface, and the composer's foot says the way out: "Cancel the schedule to edit". It's a hint, not a control; Cancel lives on the banner.
- An attempted edit (a keystroke that would change the text, a paste, a drop, a toolbar button or its shortcut) is refused and pulses that line once, so the refusal shows where the attempt landed.
- The toolbar stays in view, its buttons unavailable but still clickable, so a click pulses the same line. The actions bar keeps Send test email alone, and its dialog says it delivers the frozen copy that will fire. A draft's test dialog says it delivers the rendered email.

On a draft's Preview tab, the toolbar and the image foot dim and take no clicks, since either would change text that isn't on screen. Dropping an image still works and switches to Edit, so the insert is seen.

**Testing.** Send test email opens a dialog that takes one or more addresses and sends each its own test, so one that fails doesn't stop the rest. When every address gets it, the dialog closes with a toast. When some don't, the dialog stays open with only those addresses left in the field and says so above its buttons ("Sent to 1 of 2.", then each reason once with the addresses it covers), so Send again tries just those and no one gets a second copy. The reason is the server's sentence as it stands: the provider's words and the fix, or that the test may have arrived, so the dialog adds no "try again" of its own to a refusal that sending again can't change.

**Three copies, each named for what it is.** The Preview tab is the email; a test is the email in a real inbox; the **Web version ↗** is the post's public page. "View in browser" is not used for the last one: that is the email's own link, the post's unlisted link, worded by the publisher's template. In the Preview tab, that link opens the web version until the post is published, so a publisher who clicks it finds the page rather than "Nothing here yet".

**Unlisted, never private.** The unlisted link is public to anyone who has it, so no label calls it private: it is "unlisted", or described by who can open it ("anyone with the email can open it").

**Framed previews.** Every rendered email or reader page shows in a sandboxed frame (no script, no form), because the post and the template are HTML Claude may write, shown on the admin origin. A link in a framed email opens in a new tab, since most pages refuse to be framed and the preview would go blank. A fragment-only link, such as the sample's `#unsubscribe`, does nothing.

### Web version

The post's public page as it will look (SPEC §5), opened in its own tab with no app chrome. One full-width strip in the brand accent sits above the framed page: a **Web version** tag and "Not public yet". Below the strip, the page is exactly the public page.

- **Why the strip.** It keeps a faithful copy from being mistaken for the live page, and says no more: the publisher opened it from the post, so they know its stage, and where it will go is in Post settings and, once scheduled, the banner. It keeps the name Web version rather than Preview, which is the email.
- **Opening it.** Web version ↗ saves pending edits first, so the page shows the latest edit. It is a link (Ghost style) that opens a new tab, so no browser blocks it as a pop-up; a browser pane with no tabs opens it in place.
- **Leaving it.** The strip carries no link, since closing the tab is the way back. The page's links open in a new tab, the strip scrolls away with the page, and the tab's title reads "Web version · " and the subject.
- **After publishing.** A sending or sent post has no web version to show: its public page is the real thing, so the link goes there, through the post's unlisted link, which forwards to the archive address while the post is listed.

### Sent

The dispatch side, ordered by urgency:

1. **Attention cards** (§4) for sends that need the operator, and a line when no provider is connected.
2. **Scheduled**: the soonest send as a card with its countdown and **Edit schedule** and **Cancel**; any others fold behind "Show all N scheduled". This queue and the editor's banner are where a schedule is managed (§4).
3. **In progress**: the active-send cards.
4. **Sent posts**: search, a filter for sends with delivery failures, and sortable columns. Only the exception is marked: an email-only post carries the **Email only** mark after its subject, an envelope and the words in muted text, and a listed post carries nothing. Words and no pill, so it never reads as a second status beside the row's own; the mark stays whole on its line, and where the columns are fixed (the Drafts and Sent pages, the dashboard's Drafts card) a long title ends in an ellipsis, so the row stays one line tall. The failure filter narrows without reordering: newest first is kept, and no severity ranking is implied, because a ranking would read as a judgment the record doesn't make.

On the dev stand-in, which records sends but delivers nothing, a muted line under the title says so.

### Send page

One page for the whole life of a send once it fires (SPEC §8): the watch while it sends, then the record it becomes, in place.

**The watch** (sending) is observe-only, apart from **Resolve…** (Primary) when the server offers it for a wedged send (SPEC §12). It shows the subject with a phase pill, any attention alert (§4), and two progress bars on one scale, the audience at fire:

- **Dispatch**: how many the provider has accepted, in the sending blue, with the phase's one-line gloss and, while handing off, the rate and time to finish.
- **Delivery**: grey up to the accepted count, with green for confirmed deliveries filling in behind, so delivery visibly lags dispatch and never passes it. Its count reads confirmed of accepted.

While a send is paused, or in flight too long, the watch gives no rate or time to finish, which would promise progress nothing is making. A send too large for one sweep, waiting for the next, still reads **Sending**, with a neutral line that it resumes on the next sweep; the amber **Backing off** is kept for a pause after an error. A send paused for a provider outage reads **Backing off** with when it next retries, on its watch and on its In progress card (the Sent list's and the dashboard's), whose line leads with **Backing off** in place of **Sending**; it does so even while a batch the provider never answered waits for Resolve, since nothing goes out before the retry. The moment the provider answers a batch it reads **Sending** again. A send that comes due while another is held by a refusal or an outage is held with it from the start: it reads the same as that send (**Needs attention** with the refusal, or **Backing off** with the outage, and the same next retry), with nothing handed off yet. Its page says so in place of when it started ("Due … · held before handing anyone off · about N recipients"), and the line under its bar says it waits with the send already held. A send in flight too long keeps its **Sending** pill, since it is still open, but its gloss says nothing is being handed off, beside the amber alert that says why, and it gives no time to finish.

**The sent page** splits in two, under the subject, its phase pill, and when it was sent: **The post**, what it is on the web and what can still be done with it, and **Delivery**, how the send went. Each part is a card under a small uppercase label.

- **The post**, in two pieces, because the link and the post's place in the archive are different things. First the **Link**: one field holding the address the post's page answers at, with **Copy** and **Open ↗** attached to it (Open in the accent, as the link's own action), and a line under it: "The link in the email forwards here." while listed, or "Anyone with the link can open it. Nothing lists or indexes it." for email only. Then, under a hairline, where the post stands, in words on the left with the scheduled banner's icon (a link for in the archive, an envelope for email only, never green and grey, since neither state is the better one): "In your archive" ("Listed on your home page and in your public archive.") with **Remove from archive…**, or "Email only" ("Not on your home page or in your public archive.") with **Add to archive…**, each Secondary on the right. The ellipsis is the promise that a dialog comes first, which a checkbox or a switch would not make, since both read as acting at once. The change is the one thing about a sent post that can still change, and what changes is whether it is in the archive, never the record (SPEC §5, I3). Both ask first, in a dialog with Cancel and a Primary act. **Remove from archive…** says the post comes off the home page and the archive and its archive address stops working, including links people have shared, shows the address struck through, and says the email's link keeps working and the address stays the post's, so adding it back brings it back. **Add to archive…** says the post will be listed where anyone visiting can find it, and shows the address it was sent with, read-only ("Its address since it was sent: links people shared work again."). For a post sent before unlisted links, whose emails link its archive address, the Link shows that address, its line says "Its emails link here.", and Remove from archive… says it keeps working for anyone with the email. Each confirmed change toasts.
- **Delivery** is the record, read-only: a sent post is a frozen record (I3), so its controls are ways to look or ways out: **Export recipients (CSV)** and the recipient list's view, search, sort, and paging.

- **Outcome tiles** (Recipients, Delivered, Bounced, Complained, Unsent) go on settling as receipts arrive, while the render and the audience stay fixed. A muted caption above them says which is which, and a phase pill reads **Settling**, then **Complete**.
- **A reconciliation line** accounts for every recipient by name: delivered, awaiting a receipt, skipped, or in flight. When anything bounced or complained, it says what that does to an address: a hard bounce or a complaint suppresses it, and a soft bounce is counted and leaves it on the list. It is where a row's outcome is explained, since the row's label carries no hover text (§11).
- **The recipient list** opens on **All**, so it reads as the whole send, beside **Delivered** and **Failures** (bounced, complained, and unsent). What went wrong is already counted in the tiles above, and one switch narrows the list to it; any address can be searched. A bounce row says hard or soft by the kind recorded on it (SPEC §8), not by color. An erased person's row reads **Erased recipient**, muted, in place of the address (SPEC §7); the CSV keeps the row's placeholder.
- **Keeping its place.** When a refresh moves the counts, the list reloads on the page, view, search, and sort the reader chose, keeping keyboard focus where it was. A refresh that fails leaves the list as it is and says nothing; only a load the reader started shows an error.

**A canceled send** never fired, so its page is not a record: a **Canceled** pill, when it was canceled, and that no one was mailed.

### Subscribers

The list as a whole (SPEC §8). The head has **Import** and **Export** (Ghost) beside **Add subscriber** (Primary); when the title and the three buttons don't fit on one line, the buttons go under the title. A summary card gives the composition of the whole list; it doesn't change with the filter. Each count is also a way into the list, as the dashboard's tiles are: choosing one shows its slice, a status (suppressed or not) or every suppressed subscriber (whatever their status), with the toolbar's controls following and any search dropped, and choosing it again shows the whole list. The chosen count is marked in the Secondary palette of a pressed toggle, since it switches what you're looking at and commits nothing, and a count reads as chosen only while the filter is exactly its slice. Each count is exactly the rows its slice shows. A **Legend** toggle at the card's right edge opens, under the counts, a definition of every label a row can show, each pill drawn as the list draws it beside its meaning: the consent states, then what suppressed means and each flag that says why, then each act in a row's menu and when it's the one to use, which says whose decision it records. Each group sits under a label in the app's label style (Status, Suppressed, What you can do); the toggle already names the panel, so it has no title of its own. Its words are the ones the API reference gives a client (SPEC §7), so the publisher and Claude are told the same thing. It is part of the page, in the page's own colors, starts closed, and stays open or closed while the list reloads. The list filters by consent state and, separately, by suppression, because suppression is an overlay on an address, not a consent state (SPEC §7). A suppressed address carries a small red flag beside it naming why (**bounced**, **complaint**, **blocked**, or **erased**), never a value in the Status column. The row's pills are plain labels with no hover text; a subscriber's own detail, such as the provider's bounce message, is in View subscriber, beside how they joined. Its consent state stays in the Status column in the unsubscribed grey: still true, but not in effect while the suppression stands, so a confirmed address that bounced never reads as one that is mailed. An erasure's marker on a pending sign-up doesn't grey it: it is the one suppression that still lets the confirmation email through, and the person's own confirmation lifts it, so their pending state is still live. The legend says a status is greyed while the suppression keeps it from taking effect, which covers both. An empty list, rather than a filter that matches no one, says so with a link to the import in its text.

**How they joined** is a column beside Status, never a fourth state (SPEC §7). It is keyed on the import that brought a subscriber, not on what the file claimed: "Imported · Sendy, single opt-in" for anyone an import brought, with the origin as the service spells its name and "opt-in unknown" when the file didn't say, and "Double opt-in" only for a confirmation Kestrel recorded itself. Someone who signed up here and hasn't confirmed has nothing to say yet, an em dash, and the stacked row drops the cell.

**Every row's menu** (⋯) offers, in order, **View subscriber**, **Unsubscribe** (only for a confirmed subscriber), **Block** (for an address with no suppression) or **Unblock** (for one the publisher blocked), and **Erase**, each described below. Each act records whose decision it was: an unsubscribe and an erasure are the person's, made at their request; a block is the publisher's own (SPEC §7). **View subscriber** is a read-only dialog titled with the address, its status beneath, then how they joined, the origin and opt-in an import's file gave, the import's id, when they joined (labeled Joined, the same date as the roster's Joined column), confirmed, and left, and the evidence pretty-printed, or "None recorded", then, for a suppressed address, its flag and the provider's or publisher's words for it. An import records the file's own date (its confirmation time, else its subscription time) as the confirmation, so for an imported subscriber a line says the origin, opt-in, confirmation date, and evidence are the file's account, not something Kestrel recorded. It's on request rather than in the table, since evidence is for the rare question, not the daily scan. It's named for the subscriber rather than what it holds, so it can grow into a page for one subscriber, with their sends, without renaming.

**Add subscriber** starts double opt-in and says so. Its act is **Send confirmation**, not "Add", because no one joins the audience until they confirm (I1). **Unsubscribe**, from a confirmed subscriber's row menu, is for the person's own request, and its dialog says so: they stop receiving posts at once (I2) and can rejoin by subscribing again, and stopping mail on the publisher's own judgment is a block instead. It is confirmed with a Danger button.

**Block** is the publisher's own decision to stop mailing an address, confirmed in a dialog with a Danger **Block** that says it stops all mail whatever the person's status, which it keeps, that a person who asked to leave is unsubscribed instead, and that it can be undone. **Unblock** appears only on a block by hand, the publisher's or one an import brought, never on a bounce, a complaint, or an erasure's marker; its dialog, with a Primary **Unblock**, says whether the person will be mailed again, which they will only if confirmed. Each toast names the address.

**Erase** is in every subscriber's row menu, below Unsubscribe, since anyone on the list can ask to be erased (SPEC §7). It can't be undone, so it is confirmed in a dialog with a Danger **Erase** that says what goes (the subscriber and how they joined), what stays (past sends, showing an erased recipient; the address, kept only so it's never mailed), that it can't be undone, and that the person can still rejoin themselves. Its toast names the address, and says so when a bounce, complaint, or block the address already had still stands. An erased address that subscribed again is flagged **erased** like any suppression, and the list's legend says only their confirmation email is sent, and confirming lifts the marker.

**Adding an erased address** asks before sending. When Send confirmation meets an erased address, a second dialog stacks over Add subscriber: "Send to an erased address?", naming the address and when it was erased, and saying to send only if the person asked to join again, and that they rejoin only by confirming. Its Primary is **Send confirmation**; Cancel, the default focus, returns to the Add dialog with nothing sent. The public form never asks.

**Import** opens Import subscribers, below.

**Export** downloads the whole list as one CSV in the import format (SPEC §7), named for the day the export began. It reads every page of the export before saving anything and writes them with the same writer the server documents, so the file is the one the API's pages make, whatever the list's size. The button reads "Exporting…" until the file is saved. Nothing is confirmed, since nothing changes; a failure is a toast in the server's words, and no partial file is saved. An export finishes and saves its file even if you leave the page while it reads.

### Import subscribers

Bringing a list in (SPEC §7) at `#/subscribers/import`, under Subscribers in the navigation. It should feel obviously safe: see what Kestrel expects, see exactly what will happen, attest, commit, and get a report. The page decides nothing: the format, the limit, every outcome and count, the attestation, the sends that would grow, and the daily-writes warning are the server's, shown as they arrive (§1.2). The head is ← Subscribers, the title, and one line: "Nothing changes until you review what will happen and confirm." The rest is one of three states, in place.

**1. Before a file.** The shape comes first, so a publisher sees what Kestrel reads before being asked for anything.

- **The file Kestrel reads**, a card with a **Full list | Plain list** toggle (the Settings toggle, §7). Full list shows a three-row sample of the five columns that decide a row (`email`, `status`, `opt_in`, `origin`, `subscribed_at`), a line naming the optional columns, **Download example file (CSV)** (Ghost), and **Import format reference →** into the Docs tab, the one place every column is described, so the screen never holds a second copy to drift from it. Plain list shows a `.txt` sample, says the next step asks what the addresses are, and offers **Download example file (.txt)**. Both example files are the server's, under its names (`kestrel-import-example.csv` and `.txt`), named as examples so a downloaded one isn't taken for an exported list.
- **Just ask Claude**, a card saying Claude converts another service's export and checks it with the publisher, with a prompt to copy.
- **The drop zone**, dashed, with **Choose file**, the view's one Primary, and "CSV or .txt, up to N rows", N being this deployment's limit, followed by the server's reason when it is below the format's own.

A file the server refuses (not in the format, a value it doesn't take, too many rows) is field validation under the chooser (§5), in the server's words, with the same prompt for Claude beneath. Nothing is guessed, and the chooser keeps focus.

**2. A file chosen.** Planning writes nothing, so it runs as soon as a file is chosen or dropped; there is no Plan button. The chooser reads "Reading…" meanwhile, and once the plan is in, focus moves to the file row. One screen then holds the plan and the confirmation:

- **The file row**: name, which kind of file, rows and distinct addresses, and **Replace file** (Ghost), which opens the picker again and plans the new file from the start: its boxes unticked, and a plain list's answer back to Subscribed.
- **For a plain list**, "These addresses are **Subscribed | Unsubscribed | Bounced**", which plans again when changed, and a line that how they joined is recorded as unknown.
- **What will happen**: one line per outcome with a count, in reading order (who joins, who leaves, what else the file does, what it leaves out), the first confirming line carrying its breakdown by opt-in and origin. Addresses blocked by a suppression here and readers this list keeps as they are (unsubscribed here, or confirmed here after the file says they left) sit apart under "Kept as they are here", so nobody reads them as imported. A row that also adds a suppression is said once beneath, not counted twice. **Download the N rows not imported as subscribed (CSV)** (Ghost) gives each row's number, address, and outcome. The plan's daily-writes warning, when it has one, is the Schedule dialog's amber box (§4), in the plan's words.
- **Confirm**: a box per scheduled send that would grow ("“Owls”, sending Oct 14, 9:00 AM, goes to 25 more people."), then the attestation in the plan's words, both unticked, and under it "Only import people who asked to receive [publication]. If you’re unsure about some, take them out of the file before importing.", naming the publication as the plan's attestation does When nobody is imported as subscribed there's nothing to attest, and the card says so. Then Cancel (back to Subscribers) and **Import** (Primary).

Import stays enabled. Pressing it with a box unticked marks that box with why it's needed and moves focus there, the first missing one down the page, as Schedule does with an empty subject (§3, Editor). If the commit comes back `plan_stale` (another import landed, or the scheduled posts it would grow changed), the page plans the file again, shows the new plan with its boxes unticked, and says above the actions, with focus there: "Your list or its scheduled posts changed since this plan, so here is the plan again as things stand now. Review it, then import." The commit always sends the plan on screen and the file it was made from, and Import is unavailable while a plain list's new answer is being planned. Any other refusal of the commit goes above the actions too, in the server's words, like a dialog error (§5). The file stays only in the page: nothing is stored between the plan and the commit.

**3. Done.** The page shows the result and moves focus to its heading: what happened, per outcome as applied; any rows that turned out differently from the plan on screen, with what was planned and what was applied, in words (the commit plans again and its own `differed` covers only the commit itself, so the page also compares the rows of the plan it showed with the result's, which together name every row not imported as subscribed); "Nobody was emailed. To tell your readers about the move, write a post as usual."; and the import's record (the file, a fingerprint of it, when and by whom, and the attestation as given). **See your subscribers** is the Primary, beside **Import another file** (Ghost), which goes back to the chooser with focus on Choose file. The line that nothing changes yet goes, since something has. A commit repeated after a lost answer says it was already done and that nothing was written again.

### Template

The one email template every post is sent in (SPEC §9). The head carries the **in-use chip** ("In use by 2 scheduled posts", or a neutral chip when nothing is scheduled), as does the template section in Settings. While a scheduled post is about to send, a save is refused until it has, so the lede under the title says when it sends and that you can save once it has (with several, how many and when the last one sends), and drops the sentence once that time passes; the chip itself carries no hover text (§11). Then:

- **Sample email**: the template filled with sample values in the browser, with a 640 / 375 width toggle and **Send test email** (Secondary). The sample proves the layout, not the render, so its caption points to the test. A test always sends the saved template, so with unsaved edits the test dialog says it saves them first. A test that misses some addresses keeps the dialog open with only those in its field and names them, as the post's test does, so sending again mails no one twice.
- **What the sample binds.** The publication's identity as it stands. A name or tagline not yet set previews as a sample value so the layout reads, but the mailing address and the logo are never stood in for: with none set, the sample shows neither, exactly as the email will, since a stand-in would approve a sign-off the email never carries. The same sample appears in Settings.
- **The template editor**, with **Start from example**, a line-number toggle, Copy, and two **Required** pills (`{{ .Post.Body }}` and `{{ .Email.UnsubscribeURL }}`) that turn green or red as the template gains or loses them.
- **A note** stating the rule: one template serves every post; a change while posts are scheduled applies to their emails too, after you confirm; sent emails never change.
- **Variables**: every placeholder and what it means.

The page saves through the save bar (§6). A save that leaves a problem the template can live with, such as a mailing address the template doesn't print, saves with a warning under the editor, naming Settings without linking there. The mailing-address warning is followed by **When to provide a mailing address ↗**, the docs section that answers it, opening in a new tab so the editor stays as it was; the API's warning stays plain text.

### Settings

One page of sections, grouped by whom they serve, editable first and set-at-deploy last, so the publisher never scrolls past a fixed card to reach what they can change:

| Group | Sections |
| --- | --- |
| The publication | Publication identity |
| Its readers | Ways to subscribe, Confirmation email, Reader pages |
| Its emails | Email template, Default test recipients |
| The publisher | Notifications |
| Set at deploy | Email sender, Instance |

The groups have no headings, only a wider gap: each section's title, its **intent chip** (Editable, Preview, Copy-out, or Read-only · set at deploy), and its one-line lede already say what it is. Editable sections sit on raised cards; read-only facts sit on recessed ones. One save bar commits every editable section (§6). Rules for each section:

**Publication identity.** Its note says it is "Shown in every email" and, while posts are scheduled, how many emails a save would update and that the publisher confirms first, and, while one is about to send, when it sends and that you can save once it has. The sample email beside it shows which fields the template prints, so the note doesn't list them. It carries no in-use chip, since the identity is in every email.

- **Logo.** Shown square everywhere, so the upload makes it square: a picked image is cropped to its centered square and scaled in the browser, then saved at once. The tile is the preview, a toast says when edges were cropped, and Replace is the way back. A logo that isn't square (one set through the API) carries a warning under the tile until it's replaced.
- **Mailing address.** Optional (SPEC §9), so with none saved it isn't an empty field, which would read as a missing required value. It's an **Add a mailing address** button with a hint beside it. A saved address is an open field with **Remove**, and no status line, which would be untrue under a custom template that prints the address somewhere else. While an address is set and the template doesn't print it, an amber line under the field says so, with no link to the template and no mention of removing it, since Remove sits beside it. Each of the three, the Add row's hint, the open field's only hint, and the amber line, ends with **When to provide a mailing address ↗**, the section of Name your publication, the publisher's docs page for this card, opening in a new tab so a half-edited form stays as it was. The Template page carries the same fact as a save warning, one on each side of the pair that disagrees.

**Ways to subscribe** offers two ways onto the list as two bands of one card, in reading order. Each band has the same head: a title, a small glyph, and one line on what it's for.

- **Share the page**: the hosted subscribe page's address as plain text, with Copy and **Open ↗**, since it's a value to copy, never a field to edit.
- **Embed a form**: a **Styled | Plain** toggle, Styled first and pressed, since it pastes in anywhere looking like the hosted page and is the form most publishers want. Then the form as it will look on the publisher's site beside the snippet that makes it, so the publisher sees the code they copy. The preview is drawn at the snippet's own sizes, and the two variants must look as different as their snippets will: Styled wears the hosted page's look, and Plain is bare markup with the browser's own controls. The band ends in **Copy HTML** (Secondary). Too narrow for preview beside code, the preview stacks above it.

**Confirmation email** (SPEC §7) is preview-first: its resting state is the rendered email, and a **Preview | Edit** toggle flips to the words-only fields. There is no style choice: the email always leads with the publication's masthead, so the publisher edits words, never a layout. Because it's words, not HTML, it edits in place rather than on a page of its own.

**Reader pages** (SPEC §5) shows every page a reader can land on and sets nothing, so its chip is **Preview**. An outline lists each journey (Subscribe, Confirm, Unsubscribe, Reading) with its pages beneath; pages off the main path (an expired link, an empty archive) are marked as branches and muted. Beside the outline, a muted line says what on that journey is the publisher's: the confirmation email is theirs to word, while the confirm pages' words are fixed, so what a reader agrees to can't be edited away. The chosen page is framed exactly as a reader gets it, with a **Desktop | Phone** toggle, the address the reader meets it at, and "Sample · links and forms do nothing". The cue that this is a sample lives in the chrome around the page, never in it, so the app's voice never appears in the page being proofed. Narrower than 640px, the outline becomes a native select and the width toggle goes. An off-path page carries no mark in the select, since a branch glyph alone in an option reads as a stray character, and these pages' names already say what went wrong.

**Email template** shows the in-use chip, a read-only sample, and **Edit template →**, which goes to the Template page. Its lede says, as the Template page's does, when a post about to send goes and that you can save once it has.

**Notifications** (SPEC §8) has one field, the address, and **Send a test notification**, a check rather than the section's purpose, so it isn't Primary. The test goes to the saved address only, so while the field is blank or unsaved the button is disabled with a line saying why. Beneath, the deploy-time channel shows read-only: how notifications are sent, their From, and the **last notification**, as a "Delivered" or "Not delivered" pill with the channel's own words. A failed channel is a standing state, not an event, so it stays in its row until a later notification gets through, and is never a toast. When the channel is the newsletter's own provider, the section's note names the one notification it can't carry: the provider refusing the account.

**Email sender** and **Instance** reflect deploy configuration read-only (§1.7), with the guide that changes them. While a local server simulates a provider (SPEC §10), the provider row carries a neutral pill naming it ("Simulating Amazon SES"). Under the From address, one muted line says where readers' replies go ("Readers’ replies go to this address. Forward it to your inbox."), linking the setup guide's step for it. The app can't tell whether the forwarding exists, so the line explains and never warns (§1.3): no amber, no state, and nothing behind it to set.

### Docs and API

The docs and the API reference share one room with its own bar (back to the dashboard, a Docs or API switch, and close) over a contents rail and the page. The build stamp sits at the rail's foot, and nowhere on the publication's screens: it's for a bug report, not the publisher's day.

- **Docs** renders two sets, one doc per page: **Publishing**, for the publisher, and **Self-hosting**, for whoever runs the instance. Each set has its own index, under one header: **Kestrel docs**, one intro describing both sets and who each is for, then a tab per set (**Publishing**, **Self-hosting**), an underlined strip with the current set in the foreground over an accent rule, so it reads as something to switch. The tabs are links, since each index is its own address, and they choose what you read, never who you are. The sections follow the tabs directly. A set's own intro, written for its index file where it links the other set for a reader of the raw file, isn't repeated in the app, since the header already says it; the set's title is the tab's tooltip. `#/docs` opens on Publishing, since the Docs tab is read once Kestrel runs, mostly by the publisher; `#/docs/self-hosting` is the setup guide's index. The set stays a choice inside Docs, never a third tab in the room's bar, which chooses between kinds of document (guides, or the API). An index lists its sections in order. Each set opens with a numbered section of steps taken in order: Publishing's Set up your publication, which follows the dashboard's first-run checklist of that name, and Self-hosting's Get started. Every other section is picked from. A doc's eyebrow names its own set, linking back to that set's index, so the set always sits in the one slot over the title; the rail holds only the doc's own headings. A doc's Previous and Next stay within its section, so the main path ends at its last step.
- **API reference** lists each tier's routes under the resource they act on, whose heading stays pinned while its routes scroll by. Each route is one row (method badge, path, summary) that opens in place to its parameters, body types, JSON examples, and a curl command for this instance carrying the credential its tier needs. A filter above the first tier narrows the whole list, rail included, and `/` focuses it.

---

## 4. Sends across the app

A send appears on several screens at once: the dashboard, Sent, Drafts, the editor, and its own page. This section says how all of them stay consistent.

### One send, one truth

Every page that shows a send follows it through one shared read of the send feed (the send-state layer), which reports every send that changed, whoever changed it, and says when to look again (SPEC §8). No page keeps a poll of its own. So a send never reads one way on the dashboard and another on its own page, and no page needs a reload to catch up.

1. **Every change shows, whoever made it.** Claude's cancel, a move, or a re-make shows on the next read. How often to read is the server's answer, not the page's; a countdown ticks on the page's clock between reads.
2. **A send's home moves with it**: the editor while it's scheduled or due, its send page from the moment it starts. The editor hands off on the read that sees the start, with a toast saying why. Nothing else moves the reader.
3. **Say what is true.** "Preparing to send…", never "Sending now", from the fire time until the sweep starts the send. Missed only past the server's tolerance. Settling while receipts arrive, then Complete.
4. **Problems stay in view until they clear**, wherever the send shows.
5. **Background reads are quiet.** A hidden tab reads nothing and reads at once when shown again. A background read that fails is retried, spaced out, and says nothing; only a read the reader started shows an error. A page that has just acted asks for a read at once, so everything catches up with the act. When the server says the database is behind what the page last saw (a local reset, or a restore), each page reads its own list or send again, as if just opened.

What each screen shows at each stage:

| Stage | Dashboard | Sent | Drafts | Editor | Send page |
| --- | --- | --- | --- | --- | --- |
| **Scheduled** | Link-only card with a countdown | Card with Edit schedule, Cancel, and a countdown | Row reads scheduled | Scheduled banner with a countdown, Edit schedule, and Cancel | Opens the editor |
| **Due** (fire time passed, not yet started) | Card reads "Preparing to send…" | Same card, without Edit schedule and Cancel | Row reads scheduled | Banner reads "Preparing to send…", its controls disabled in place | Opens the editor |
| **Sending** | Active-send card | In progress card | Row reads sending, opens the watch | Never shown: hands off to the watch | The watch |
| **Needs attention**, or in flight too long | Health line | Attention card, or a note on its In progress card | As sending | As sending | Alert at the top; Resolve for a wedged send |
| **Settling** | Row in Sent, Delivered follows the counts | Same | Gone | Never shown | The record, Settling |
| **Complete** | Row with its final Delivered | Same | Gone | Never shown | The record, Complete |
| **Canceled** | Card leaves the queue | Same | Row reads draft again | Banner goes, post editable again | Canceled page |

### The review window

**The scheduled banner** (editor) and **the scheduled card** (Sent) are where a schedule is managed. Both carry **Edit schedule** and **Cancel** as equal-weight Ghost buttons: both act on the pending send without editing its content, and neither is the view's Primary. The dashboard's card is link-only.

- **The countdown** says "Sends in …", coarsening with distance: seconds in the last five minutes, then minutes, hours, and whole days.
- **At the fire time**, on the page's own clock, the countdown becomes "Preparing to send…" and the window controls go: the card hides them, and the banner disables them in place, since the page hands off within seconds. A later read that still offers them doesn't bring them back. "Sending" is only ever said of a send that is.
- **Past the server's tolerance**, both read "Missed its fire time · N min late" in red.
- **Cancel** acts at once, with no confirmation, because a cancel is fully reversible: schedule again. A Cancel that loses the race with the fire time says so plainly: the send time has passed, so the email is going out.
- **Edit schedule** opens the Schedule dialog again, titled "Edit schedule" and without Send now: the time, then the post's settings, with **Cancel** and **Save**. Save applies whatever changed, the time, the settings, or both, so its label never changes as you edit; the toast says what happened, "Rescheduled" when the time moved and "Saved" when only the settings did. Each goes through its own route, the settings first, so a refused address shows under its field and moves nothing; if the time then can't move (the send has just fired), the dialog closes saying the settings were saved and the send time didn't change. Only a moved time is checked against the lead, so the settings alone can be saved up to the fire time. Not plain "Edit", which beside the locked post (its foot says "Cancel the schedule to edit") would promise what it can't do. The content stays frozen and the window is kept. Its control stays live even when no provider is connected, since moving a send sends nothing.
- **Where the post is going.** The editor's banner has two rows. The top one holds the time, the notes about sending (held, re-made, not yet tested, daily writes), and Edit schedule and Cancel, which act on the schedule. Under a hairline, on a shade deeper of the same violet and led by an icon in the same violet (a link for the archive, an envelope for email only), the bottom row says what the send will do: "Sends by email and publishes at `newsletter.example.com/archive/spring-update`", led by the link icon, or "Sends by email only", led by the envelope. It names both acts, so it says everything that will happen, and takes the top row's own verb and tense ("Sends in 2 days"), present for what is still to come, so the two rows read as one. Not the past tense ("Sent to email…"), which a first-time reader takes as already done whatever the time above says. The address is shown because this is the last look at it before it is fixed. It is said once, so the top row carries no tag and the head no Email only label. Only this banner, on the post's own page, says it in full; a scheduled card under Sent or on the Dashboard is an item in a list, and marks only the exception after the time: "Email only".

### A send the database may not cover

On the Workers Free plan's limits, a send to more than 5,000 recipients may use up the database's daily writes, and a smaller one may on a day imports have already written (SPEC §8). The warning is the server's `daily_writes` condition, in its words, and it never disables a control.

- **The Schedule dialog**, and its Send now view, show it as an amber box under the hint, the not-connected line's look, once the audience is read and found over the threshold. Schedule and Send now stay live: the account may be on Workers Paid, and the review window is where the publisher decides. The dialog reads the audience only on Free's limits, and only once for both views. It judges by the audience alone: what the day's imports wrote is the scheduled send's condition to count, so a send that fits alone but not beside them first warns on the banner, once scheduled, inside its review window. An import that lands while the send is scheduled puts the line on an open banner in place, without a reload.
- **The scheduled banner** carries the same words as a line under the countdown, for as long as the send is scheduled. The line keeps the banner's own violet, led by an amber ⚠️: a warning that blocks nothing shouldn't outweigh the send it's about, and the mark says it's worth a look without coloring the words.
- **Nowhere else.** It isn't an attention item: nothing is wrong yet, and the health block is for what needs a person now (§1.3).

An import plan's warning about the same limit (SPEC §7) is the same amber box on the import screen (§3, Import subscribers), in the plan's words.

### Re-making scheduled emails

A change to the template, or to an identity field the template shows, while posts are scheduled re-makes their emails (SPEC §8). The server refuses the save until the publisher acknowledges it, and the UI reacts to that refusal; it never decides which fields count.

- **The confirmation** is a dialog: one sentence on what the save reaches, the sends by subject and fire time, and three facts in a label column (what changes: the look; what stays: the content and fire time; what's next: a fresh test), so the consequence is scanned rather than read. The alternative, a second template, is named in muted text as not yet offered. Its Primary is "Save and apply". Declining leaves the edits unsaved.
- **A save refused because a send is about to fire** shows where that surface's errors live (the save bar, or under the logo), naming when to try again.
- **Afterwards**, the toast says how many emails changed and that each needs a test again. Then each re-made send carries the server's `remade` condition until a test of the new copy is sent: the condition's own line in the post's scheduled banner, which says the template or publication details changed the email's look, that its content and send time are the same, and to send a new test, with no button of its own since Send test email is in the actions bar below; and a "Look changed since your last test" mark on the dashboard's scheduled card. It is the same fact Claude reads, so it can't be dismissed without testing; it goes when the test lands. The Sent queue's card carries no mark, since the editor is where the test is.

A scheduled send no test has been sent for carries the server's `untested` condition, an `info`: its own line in the banner, styled as the re-made line and in the server's words, until the first test lands. It shows nowhere else, not on the dashboard's or the Sent queue's cards and not in the health block, since nothing is wrong (§1.3).

### Attention

The **health block** on the dashboard, the **attention cards** on Sent, and an **alert** at the top of the watch carry the conditions the server reports as needing a person (§1.3). They are repainted from every read, in the server's words, and leave only when the condition clears. Red is for a condition someone must act on, amber for one to keep an eye on:

| Condition | Tone | Where, and what it offers |
| --- | --- | --- |
| Missed fire time | red | Health line; the scheduled card and banner read "Missed its fire time · N min late". |
| Wedged send | red | Health line linking to the send; attention card and the watch carry **Resolve…**. |
| Provider refusing the account, or this send | red | Health line, attention card, and watch alert, each with the provider's words and one sentence of advice that names the fix and who makes it. No control: nothing in the app fixes it, so the subject links to its watch. The watch's headline says "refusing this account", or "refusing this send" when the provider refuses the send's own email. The copy says no one has been marked unsent because of this, so it stays true beside readers unsent earlier, and the send resumes once it is fixed, and the watch names the next retry. |
| In flight too long | amber | Health line, a note on its active-send and In progress cards, and a line at the top of its watch. |
| Rate limit the deployment causes | amber | Health line and a line at the top of its watch, in the server's words, which name `SES_MAX_SEND_RATE`. An ordinary outage or rate limit raises nothing (below). |
| Bounce spike | amber | Health line linking to the send's record. |
| No receipts | amber | Health line linking to the send's record (one line for several sends, linking to Sent), and a line above the record's tiles that goes when a receipt lands. |
| No provider connected | amber, or red once it holds a send | Below. |

A send that needs the operator leaves the active-send cards and In progress, so it is reported once. A provider that is only unavailable is not an attention item: the send reads as in progress, its phase gloss says the provider is unavailable and when the next retry is, and the in-flight-too-long flag raises it if it lasts.

**Resolve** explains why the send can't finish on its own and offers **Assume not sent** and **Assume sent**, with Cancel. Neither choice re-mails anyone (I4), so the dialog explains a trade-off in the record's accuracy, not a danger. Since the app can't tell whether those emails went out, the dialog names **Assume not sent** as the safe default and **Assume sent** as the choice for when the operator knows otherwise.

### No email provider

Two states have no real provider (SPEC §9), and each is worded for who meets it.

**Local development** (and the tests, and a hosted demo) sends through a stand-in that records a send but delivers nothing. A confirmation like "Test sent to 2 addresses" would read exactly like a real send, so send-action toasts end with "(local stand-in: nothing is delivered)", and the Sent page carries a muted line saying the same. The copy never says "fake transport".

**A deployment partway through setup is not connected.** It refuses every send, so there's nothing to confirm; the operator needs the way out. Every mention names the state ("No email provider connected"), says what it stops, and links **Connect Amazon SES** to the guide. It is a standing state, true every time the reader looks, so it is never dismissible. It shows wherever a send would be refused, before the publisher tries:

- **Dashboard and Sent**: an amber line, the one health line with no send behind it. The setup checklist's provider step replaces its check-your-setup step, and its subscribe-link step says signups open once a provider is connected. While the dashboard's Finish setting up card carries that step, the card says it and the health block doesn't (§3).
- **A draft's page**: the same amber line above the actions, "No email provider connected: you can write and preview, not send", so the publisher knows before opening a dialog.
- **A scheduled send**: the dashboard's card and the editor's banner keep their countdown, since the window is real and still cancelable, and add "Will be held: no email provider is connected." On the white card the line is amber. On the banner it is a line under the countdown like the daily-writes one, in the banner's own violet led by an amber ⚠️, since amber words on violet are hard to read and would mix two of the color meanings. It keeps a heavier weight than the daily-writes line, because a held send doesn't go out.
- **Every dialog that would send** (both test dialogs, Schedule, Add subscriber): an amber line, the act disabled, and the fields it would need left out, so there's nothing to fill in. Focus lands on Cancel.
- **Settings**: the provider row carries the state and the link; Ways to subscribe says signups aren't open yet; Notifications reads "Your email provider, once one is connected".

**A send held for want of a provider** (scheduled before the provider went, now due) is said once, together with the state, in red, since two statements of one cause read as two problems. On the dashboard it is the health block's one red line; on Sent, one attention card naming each held send. It says no one was marked unsent and the send goes out at its first retry once a provider is connected, then the fix: connect one, then deploy. In local development's preview of this state (SPEC §10) there's nothing to deploy, so the fix is to restart `npm run dev` without `SIMULATE_SENDS=not-connected`.

These controls are disabled from the deployment's own description of itself, read once at boot; the server still refuses whatever gets past them, and its refusal shows as a toast in its own words. A configured deployment shows none of this, and none of it is ever part of a post's frozen record (I3).

---

## 5. Messages: where feedback goes

Every message has exactly one home, chosen by how long it lives and what the reader must do about it. A message never appears in two homes at once. Most feedback bugs are a message in the wrong home.

| Home | What goes there | How long it lives |
| --- | --- | --- |
| **Toast** | The result of an act the reader just took, including a failure with nothing standing to fix. | About three and a half seconds. |
| **Save bar** | An explicit-save surface's unsaved edits, and why the last save didn't go through. | While there are unsaved edits. |
| **Save cue** | The editor's save state: Unsaved, Saving…, Saved, or why the last save failed. | Continuous; a failure stays until a save succeeds. |
| **Banner** | A standing state of the screen's subject, with its actions: the editor's `scheduled` and `conflict` banners. | While the state holds. |
| **Field error** | Why one field's value is refused, beneath the field, on a page or in a dialog. | Until the value changes. |
| **Dialog error** | Why a dialog's act didn't go through, when no one field is at fault, just above its buttons. A page whose act sits at its foot, like Import, says it the same way. | Until the next try. |
| **Attention** | A condition someone must act on (§4). | Until the condition clears. |
| **Standing line** | Why an act is unavailable, such as no provider connected (§4). | Every time it's shown, while it's true. |
| **Wall** | A state in which nothing in the app can work (§2). | Until reload. |

**Choosing a home.**

- A toast is never the only record of something that lasts. If the reader could come back later and need to know it, it belongs in a banner, attention, or the page itself.
- **A toast carries a failure only when nothing standing is left to fix**: an act with no surface of its own (New post, a row or card action, a copy the browser refused, the save a leave makes after the page is gone). A failure with a home (a field, a dialog, the save bar, the save cue, a channel's status row) says so there and nowhere else.
- **Errors are in the publisher's words.** The server's message stands when it was written for people; a bare code, a bare "not found", or a dropped connection is said plainly instead ("Couldn’t reach Kestrel. Check your connection and try again.").
- **A dialog says its own errors.** A toast at the foot of the screen is far from the field it's about, and gone in a few seconds while the dialog stays open. The error goes under the field at fault, which is marked invalid and focused, and clears as soon as it's edited; otherwise just above the dialog's buttons.
- **A surface with a save bar says why a save failed in the bar**, where it stays until the next save. A toast would sit over the bar and vanish while the edits it's about are still unsaved.
- A refusal about one field goes on that field, including a server refusal that names it (`field` on the error, `docs/API.md`): the field is marked and focused, and the save cue or save bar says "Not saved: fix the field marked above." Disabling the act instead is allowed only when the reason is visible beside it.
- A background read that fails stays quiet (§4).

**Toasts.** At most three show at once, newest nearest the bottom; a fourth sends the oldest away early. A message already showing restarts its time instead of stacking a copy, so five clicks on a button read as one. A toast may carry the one next step a success leaves, such as "Send yourself a test". Toasts sit above the save bar and above dialogs (§9).

**The conflict banner.** When another writer (a second tab, or Claude) saves a newer version, the banner says who and offers **Reload** and **Keep editing** as equal-weight Ghost buttons. Both choices lose something (Reload discards local edits; Keep editing overwrites theirs), so presenting either as the safe default would be a lie about the trade-off. Saving waits on the choice, and the banner says so. Meanwhile **Save draft** reads as unavailable but stays clickable: a click, or ⌘S, saves nothing and brings the banner into view. It never means "keep editing and save", since one click would then overwrite a version the publisher hasn't seen.

**A post deleted elsewhere** isn't a banner. Whatever read or write finds it gone toasts once that the post was deleted elsewhere and goes to Drafts.

**No dismissible notices.** A message that the reader clears, and that the server never hears of, would let the editor and Claude disagree about what is true. The one candidate there was, a re-made send, is a condition the server already reports and settles (§4), so the app has no notice home. A new message that seems to need one is first a question for the server: is it a condition of something?

**Emailed notifications aren't a home.** The notifications that tell the publisher about a send (SPEC §8) arrive in their inbox and have no echo in the app, since what they report already stands where it's managed. The one trace is the channel's own state, in Settings.

---

## 6. Saving

Every surface that edits something saves one of two ways, and commits to it whole. Mixing them (an autosave surface that also shows a save bar, an explicit-save surface that quietly persists) is the confusion this rule exists to prevent. The question that picks one: is there a meaningful unsaved state the reader should be able to revert?

**Explicit save** (Settings, the Template page). Edits accumulate against the last saved state, and the reader commits or discards them on purpose through the **save bar**, which slides up from the bottom of the screen with **Discard** and **Save changes** while there are unsaved edits, and away once they're saved, with a toast saying so. If a save doesn't go through, the bar says why (§5). The logo is the one exception: it saves the moment it's picked, so whatever kept it from saving shows under its tile.

**Autosave** (the post editor). The draft saves as you type, after a short pause and never more than half a minute late, with the **save cue** beside Save draft. Save draft and ⌘S save at once. A save that fails turns the cue red, "Not saved:" and the reason, which stays until a save succeeds. After a dropped connection, a server error, or a 429, the editor tries again on its own, a little further apart each time, so it recovers without another edit. Any other refusal the server would repeat isn't retried: it stays on the cue until the next edit or Save draft. A conflict (409) opens the conflict banner instead, and a post deleted elsewhere (404) shows that it was deleted. Its Unsaved reads in the same amber as the save bar, so the two models feel like one app, and the state is in its words, never the dot's color alone. The editor needs continuous saving and conflict handling the save bar has no words for, so it never uses the bar.

**Read-only** surfaces pick neither, because there's nothing to save. The send page is the example: the record is frozen (I3), and the watch only observes.

**A save that reaches scheduled emails** confirms first, the same way on every surface (§4).

---

## 7. Buttons and controls

Every button plays one of five roles, chosen by importance and consequence, not by where it sits. Each role is one class.

| Role | Use it for | Looks |
| --- | --- | --- |
| **Primary** | The one act the reader came to this view to do. **One per view**, and one per dialog. | Solid accent fill. |
| **Secondary** | An important standing act that isn't *the* act: Send test email, Copy HTML. | Soft accent fill, accent text. |
| **Ghost** | Anything quiet: back, Cancel, Edit schedule, a menu trigger, a pager. The default. A plain `button` reads as Ghost. | Neutral, bordered or bare. |
| **Danger** | A destructive act. Solid only as the confirming button of a dialog; the subtle variant everywhere else, neutral until hovered, so it never shouts over its row. | Red. |
| **Icon** | A square control where a label would be noise: ⋯, dismiss, close. Always has an `aria-label`. | Ghost, square. |

The roles differ by fill, border, and weight, **never by height**: every labelled role shares one height, so a row that mixes them lines up.

**Rules.**

- If two acts both feel Primary, one of them is Secondary.
- A destructive act is confirmed in a dialog whose text says what is lost and whether it can be undone. A reversible act (Cancel a schedule, Edit schedule) is not confirmed, unless it stops or resumes mail to a person (Block, Unblock), or changes who can find a published post (Remove from archive…, which breaks links people shared, and Add to archive…, which puts it in front of the public), which is confirmed in a dialog that says so.
- An unavailable control is either `disabled`, with its reason shown beside it (a not-connected dialog's act, a test with no saved address), or unavailable but still clickable (`aria-disabled`), when the click itself should point at the way out, like Save draft under the conflict banner or the locked composer's toolbar.
- In a label, **→** navigates within the app, **↗** opens a new tab (and says so to a screen reader), and **…** opens a dialog that asks more.
- If a new button doesn't fit a role, reconsider the button before adding a role.

**Controls outside the five roles, on purpose:**

- **Toggles and tabs** (**Edit | Preview**, **Styled | Plain**, **Desktop | Phone**, **All | Delivered | Failures**, **Full list | Plain list**) switch what you're looking at; they never commit an act. A plain list's **Subscribed | Unsubscribed | Bounced** is one too: it changes what the plan shows, and planning writes nothing. So are the Subscribers summary's counts, each choosing its slice of the list. The small pill toggles mark the pressed segment in the Secondary palette, and a section's main toggle is a step more prominent than one that only changes a preview's width.
- **The text link** (`linkbtn`) is an act styled as a link, for a choice that must read as clearly demoted below even Ghost: Send now → in the Schedule dialog. Use a real role anywhere a demotion isn't the point.
- **Copy** is a utility on a value, not an act on the publication: the word and a glyph that turns to a check for a moment when the copy lands. It says it worked where it sits, never with a toast, unless the browser refuses the clipboard. The docs' code blocks still carry an older word-only button that reads "Copied".
- **Mockups** of reader controls (the embeddable form's Subscribe button) are inert and unfocusable, filled with the reader's ink rather than any role's color, because they show the reader's chrome rather than offer an act.

---

## 8. Color

A color means one thing, and a token names one color. A second token for a color that already has one is how the interface drifts. Every token has a light and a dark value; `npm test` checks that every token used is declared and every color has both.

| Hue | Means | Where |
| --- | --- | --- |
| **Accent** (slate blue) | The act | Primary and Secondary buttons, links, the Editable chip, the publisher-only strip. Fixed: the publication's own theme never changes it. |
| **Violet** | Scheduled, in its review window | The scheduled badge, cards, banner, and the in-use chip. Off the accent so a scheduled send never reads as the thing to click. |
| **Sending blue** | In flight | The sending badge, the dispatch bar, active-send cards, the Sending and Settling pills. Its own shade, not the accent. |
| **Green** | Done and fine | Sent, confirmed, delivered, Complete, Saved. |
| **Amber** | Worth a look | In flight too long, a bounce spike, no receipts, not connected, Unsaved, a pending subscriber, retrying, render warnings, the conflict banner. |
| **Red** | Went wrong, or needs a decision | A missed fire time, a wedged send, a refusing provider, complaints, suppression, destructive acts, a refused save. |
| **Grey** | Inert, or a fact about where something lives | Draft, unsubscribed, unsent, skipped, canceled; Read-only · set at deploy; Email only. |
| **Ink** | Strong text | Headings and strong labels. Never a button fill, except the inert reader mockups (§7). |

**Lifecycle hues are facts, not verdicts.** Draft grey, scheduled violet, sending blue, and sent green are kept apart from the feedback scales: a scheduled badge is neither good nor bad. A state borrows a feedback hue only when it really carries that reading. A pending subscriber is waiting on the reader, so it takes amber, never sending blue, which would read as a send in flight. A suppressed address takes red, and its consent state the grey of unsubscribed: a subscriber's grey means not mailed, and the label still names the state.

**Delivery outcomes are verdicts.** On the record, delivered is green, bounced amber, and complained red, sitting beside the lifecycle `sent` badge; the two scales together are why they mustn't be conflated. Each recipient row uses the same swatch as its tile, plus sending blue for accepted-not-yet-confirmed and grey for unsent or skipped. The send lists compress the same outcomes to a **Delivered** count, with any complaints, bounces, or unsent named beneath it in words, worst first. A clean send prints nothing there.

**Code palettes borrow no meaning.** Syntax highlighting (in both editors) and the API reference's method badges are self-contained palettes: GET isn't a success and DELETE isn't an error.

**Never by color alone.** Every badge, pill, swatch, and dot sits beside a word.

---

## 9. Layout

**Stacking** is one ladder, and every fixed or floating surface takes a rung by token, never a bare number: page content, then sticky headers and the sidebar, menus, the save bar, modals, and toasts on top. A menu opens over the page; a modal covers the page; a toast sits above everything, so one raised while a dialog is open (an autosave that failed, a send that started) is never dimmed beneath its backdrop. A dialog still says its own errors inside it (§5), since a toast at the foot of the screen is far from the field it would be about.

**Narrow screens.** The editor gets opened on a phone, often just to check a post went out, so every screen holds at any width, and a list never makes you scroll sideways to read its lead column. At phone width, a list table stacks: each row becomes its lead cell (subject, email) on its own line, with the rest as one muted line and the row's ⋯ at top right; column headers drop, search and filters stay. It's the desktop table's own markup restyled, not a second render, so the two can't drift. Subscribers stacks sooner, whenever its own width leaves the email less than about 250px beside its three other columns, so the sidebar's width counts and a mid-sized window gets the stacked rows rather than a squeezed address; an address that has to wrap breaks before its @. The per-recipient table on the record is the one holdout, and scrolls instead.

The docs room's bar stays one row at every width, so its anchors always clear it. On a phone, a doc's contents fold to one row that closes once a section is picked, the API rail becomes a chip row, and the build stamp moves to the foot of the page.

---

## 10. Copy and voice

**Who speaks.** The UI speaks to the publisher as "you", and calls itself "Kestrel" when it has to. Claude is "Claude", including as the author of a revision. Never "we".

**Use the spec's words.** A **post** is what the publisher writes; a **send** is one dispatch of it. **Delivered** always means a receipt confirmed it; a provider's acceptance is **accepted**. A delivery failure is a **bounce**, a **complaint**, or **unsent**. Consent states are **confirmed**, **pending**, and **unsubscribed**; **suppressed** is the overlay. "Consent" itself stays the spec's term, not the screen's: on a screen, say what the reader did ("agreed to receive your posts", **How they joined**), since the bare word reads as legal and can alarm a publisher who did nothing wrong. Never internal names in the UI, such as "fake transport".

**Name a thing by what it is.** The Preview tab, a test, and the web version are three copies of a post, named for what each is (§3). The schedule's freeze reads as "locked" and "Cancel the schedule to edit". Where the spec says a scheduled email is *re-made*, the publisher reads that a change *applies to* scheduled emails, that they were *made again*, or that an email's *look changed*.

**The server's words stand.** A condition's message, a refusal, and the provider's own words are shown as they arrive. If the words are wrong, fix them on the server, where Claude reads them too.

**Say the next step.** A refusal or a lock names what to do and where: "Cancel the schedule to edit", "Add a subject before you schedule". When something changed that the publisher didn't do, say what and why: "Your send started, so this page switched to its live watch."

**Be honest about time.** A send is never "now" or "immediately"; there is always a window.

**Mechanics.** Sentence case for buttons and headings. Counts pluralize ("1 recipient"). A busy button says what it's doing ("Saving…") until it's done. Typographic apostrophes and quotes. A colon, a comma, or a new sentence rather than an em dash; an em dash stands alone only as the mark for an empty table cell. A date and time is short and local ("Feb 11, 2:00 AM"), and shows its year whenever that isn't the current year, past or future ("Feb 11, 2024, 2:00 AM").

---

## 11. Accessibility

- **Focus.** One focus ring everywhere, on `:focus-visible`. A dialog keeps focus inside it, starts on the caller's chosen field or else its first control, and returns focus to whatever opened it. A wall moves focus to its heading. A menu opens with focus on its first item.
- **Keyboard.** Escape closes a dialog or menu. A menu moves with the arrow keys, Home, and End. ⌘S saves the view where it saves; ⌘B, ⌘I, and ⌘K format in the composer. A clickable row or card always contains a real link to the same place.
- **Names.** Every icon-only control has an `aria-label`. A ↗ link says it opens a new tab. An info tip is reachable by keyboard and touch.
- **No hover-only meaning.** A badge or pill is a plain label with the default cursor and no hover tooltip (`title`), which keyboard, screen-reader, and touch users can't reach and some browsers don't show. What a label means is said once, in words on the page: beside it, in the section's lede, or in a legend such as the Subscribers list's or a line such as the record's reconciliation line.
- **Live regions.** Toasts are announced politely. The conflict banner, field errors, and dialog errors are alerts, and a field's error is tied to the field so a screen reader reads it with the field.
- **Not by color alone** (§8).
- **Motion.** Under reduced motion, transitions and animations are off; the locked composer's pulse becomes a steady tint.

---

## 12. Deliberately left out

Each of these was decided, not forgotten. Adding one is a design change, and most are a spec change first.

- **Pausing, resuming, or ending a send in flight.** The watch is observe-only apart from Resolve (SPEC §12).
- **An instant send.** Send now has a window (I6).
- **Editing a scheduled post in place.** The lock guarantees that what fires is what was reviewed; editing goes through Cancel.
- **More than one template, template history, or undo** (SPEC appendix).
- **Open and click analytics.** The record is about delivery.
- **A WYSIWYG editor.** The post is Markdown and the template is logic-less HTML; the toolbar inserts Markdown rather than hiding it.
- **Editing deploy configuration** (§1.7).
- **Server-side "seen" state, saved layout preferences, and in-app themes.** Toggles are per browser or per load, and light and dark follow the system.
- **Emailing the publisher about a bounce spike.** It shows on the dashboard only (SPEC appendix).
- **Hover text on a label.** A label's meaning lives in words on the page, never only in a `title` on hover (§11).
- **Clearing a bounce or complaint, or unsubscribing a pending subscriber, from the editor.** The API offers both; the editor clears only the publisher's own block. When clearing a bounce or complaint is added, it must be a confirmed act, never a toggle (SPEC §7).

---

## 13. Changing the UI

Before a UI change is done:

1. **The behavior is in the spec.** If the change alters what the publisher can rely on, `docs/SPEC.md` changes first; this document only presents it.
2. **The server decides it.** A condition, whether a control works, or a pace comes from the API. If the client would have to derive it, the API is missing a field (`docs/API.md`).
3. **It uses the vocabulary.** Each message in its home (§5), each act in a role with one Primary per view (§7), each color by meaning (§8), each word from the spec (§10).
4. **It works for everyone.** Both themes, keyboard and screen reader (§11), and a phone-width window with no sideways scroll (§9).
5. **The documents move with it.** The section here that governs the change, and a `CHANGELOG.md` line for anything the publisher would notice, in the same commit.
