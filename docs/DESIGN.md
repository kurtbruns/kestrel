# Kestrel — design

The UX contract for Kestrel's admin UI. It is the presentation-layer sibling to `docs/SPEC.md`: where the spec governs behavior — what the system guarantees and how it's shaped — this document governs how that behavior is presented, so the interface stays coherent as it grows. It names the small set of roles a control can play, where a notification is allowed to appear, what the tokens mean, how surfaces stack, and how saving works. The concrete tokens and classes live in `public/dashboard/styles.css`, and the behavior that drives them in `public/dashboard/app.js`; this document describes what they mean and which one to reach for, not their exact declarations.

The scope is deliberately small. This is a framework-free app with no build step, so the contract is a shared vocabulary — one class per role, one home per notification kind, one semantic palette, one stacking order — not a component library, a token pipeline, or a theming system. A new treatment is a smell: reach for an existing role before inventing one, and if none fits, change the contract here in the same breath as the code (see CLAUDE.md's sync rule).

This covers the **admin UI only** — the editor and authoring surfaces behind auth. The reader surface (archive index, per-issue pages) is governed by SPEC §5 and §10 and is intentionally not styled from these tokens. The single, deliberate exception is the dev-only "Open dashboard" shortcut the reader surface shows on a local dev instance (SPEC §5): it is app chrome, not the publication's identity, and it links *into* the app, so it wears the brand accent (`--accent`, §3) rather than the reader ink — the one place that token appears off the admin surface. It is present only in local dev and structurally absent once deployed.

---

## 1. Buttons — five roles

Every button in the admin UI plays one of five roles, and each role is one class. The role is chosen by *importance and consequence*, not by where the button sits. A view has at most one Primary; everything else steps down from there.

| Role | When to use | Class | Token mapping |
| --- | --- | --- | --- |
| **Primary** | The single most-important action of a view — the one thing you came to this view to do. **One per view.** | `button.primary` | Solid `--accent` fill, `--accent-on` text and border. |
| **Secondary** | An important standing action that is not *the* action — e.g. "Send test email" beside a Save. Soft, accent-tinted, clearly clickable. | `button.secondary` | `--accent-soft` fill, `--accent` text, accent-tinted border. |
| **Ghost** | A quiet, neutral action — back, cancel, a menu trigger, a pager step. The default for anything that isn't asking for attention. | `button.ghost` | Transparent (or card) fill, `--ink`/`--muted` text, `--line` border or none. |
| **Danger** | A destructive action. Solid only for a final confirm in a modal; the subtle variant everywhere else, so a destructive control never shouts over the row it sits on. | `button.danger` (solid) · `button.danger-subtle` | `--danger-*` scale (§3). Subtle rests neutral and reveals red on hover. |
| **Icon** | A square, icon-only control where a label would be noise — a close ✕, an inline edit, a toolbar glyph. Always carries an `aria-label`. | `button.icon` | Inherits Ghost's neutral treatment; sized square. |

Primary is Kestrel's own brand accent, `--accent` (a fixed slate-blue) — never the near-black neutral. That near-black used to be a second button fill (`button.primary` filled with `--accent`); it is retired as a fill and lives on only as the `--ink` text token (§3). There is exactly one solid brand-blue action in front of the writer at a time.

The roles differ by **treatment — fill, border, weight, font-size — never by height.** All the label roles (Primary, Secondary, Ghost, Danger) share one box height, so a row that mixes them aligns: a quieter, smaller-font role grows to the shared floor with its label centered rather than sitting a few pixels short of the Primary beside it. A role's importance is carried by how it looks, not by making the less-important one smaller. Only the square Icon and the segmented toggle Control keep their own sizing.

These five absorb the treatments the UI accumulated before the contract existed: the bare `button`, `.ghost-btn`, and `.set-btn-ghost` idioms all collapse into **Ghost**; the accent-tinted "Send test email" look (`.set-btn-accent`) becomes **Secondary**; the one-offs (`.sub-btn`, `.doc-pager-btn`) and the settings menu trigger (`.set-menu-btn`, which becomes Secondary or Ghost plus a caret) fold into the roles above. If a new button doesn't fit one of the five, that's a signal to reconsider the button, not to add a sixth role.

### Toggle is a Control, not a button

A segmented toggle (`.wtog`) — the pressed-state pill group used to switch a mode or a view — is a **Control**, documented apart from the five button roles. It carries `aria-pressed` on its segments, and the active segment uses the Secondary palette (`--accent-soft` fill, `--accent` text). It is not a Primary, and it is never the thing a Primary would be: a toggle changes what you're looking at, it doesn't commit an action.

### Link is a link, not a sixth button

`button.linkbtn` renders an action as a text link — accent-colored, underlined, no fill or border — and is not one of the five button roles; it's the presentation of a hyperlink applied to a `<button>` (so it stays keyboard- and screen-reader-reachable) for an in-page action that navigates nowhere. Reserve it for a *deliberately subordinate* path that must read as clearly demoted, below even Ghost: the canonical case is **Send now** inside the Schedule modal, where scheduling behind the review window is the default the Primary commits to and sending immediately is the step-down choice. A Ghost button there would sit level with Cancel and undo the demotion; the link says "lesser path" at a glance. If you reach for it anywhere a real button role would do, prefer the role — the link is for demotion, not decoration.

---

## 2. Notifications — one home per kind

Feedback has five homes. Each kind of message belongs to exactly one of them; the home is decided by *how long the message lives and what the reader must do about it*, and a message never appears in two homes at once. The wrong home is the bug that lets a transient toast and a persistent save bar fight for the same corner.

| Home | What it's for | Where it lives |
| --- | --- | --- |
| **① Toast** | Transient confirmation only — a success that needs no action and then vanishes ("Settings saved"). Never an error the reader must resolve. | Fixed region, bottom-center (`#toasts`), above everything (`--z-toast`). App-wide. |
| **② Save bar** | The state of an explicit-save surface: unsaved / saving / saved, plus **its blocking error, owned in-bar**. Explicit-save surfaces only (save model A). | Fixed bottom bar (`.savebar`), spanning the content column. Never the editor. |
| **③ Editor-state banner** | A persistent, in-flow notice at the top of the editor. One component, three variants: `info`, `scheduled`, `conflict`. | Top of the editor body, in the content flow (not fixed). |
| **④ Field validation** | An error about one field — the field's own invalid state plus a message directly beneath it. | Attached to the field it concerns, inline. Never a toast, never the banner. |
| **⑤ Autosave cue** | The lifecycle of continuous autosave: Unsaved / Saving / Saved (save model B). | Inline in the editor chrome, beside the editor's controls (`.save-status`). |

The **editor-state banner** is one component with variants, merging what were two banners (`.sched-banner`, `.fresh-banner`): `info` is a neutral notice, `scheduled` marks a frozen/soft-locked post (SPEC §6), and `conflict` warns that the draft changed elsewhere (another tab, or Claude). The `scheduled` variant carries the two schedule-management actions — **Reschedule** (move the fire time) and **Cancel** (unschedule) — as **equal-weight Ghost**: both act on the pending send without editing its content, and neither is the view's Primary (the editor's Primary is Schedule, and it is absent while locked). Those same two actions ride the sent-status queue's scheduled card; the dashboard's scheduled card stays link-only (SPEC §8). A `conflict`'s two actions are **equal-weight Ghost** too — both choices lose something, so neither is dressed as Primary: Reload discards local edits, Keep editing overwrites the other writer's copy. Presenting one as the safe default would be a lie about the tradeoff.

The **autosave cue** shows a dot-and-label triple: *Unsaved* (an amber `--warn` dot), *Saving…* (a pulsing/muted state), and *Saved* (a green `--ok` state carried by an icon and label, **never color alone** — the state must survive a reader who can't tell the dot's color). The "unsaved" cue reads identically to the save bar's unsaved dot so the two save models feel like one app.

Two collisions the homes-plus-layering rules exist to prevent, recorded so they don't recur: a toast and the save bar can share the bottom of the screen, so the toast sits above the bar on the z-scale (§4) rather than behind it; and the save bar's error state is a distinct state class (`.savebar.is-error`), *not* the bare `.error` of the global alert component — reusing `.error` let the alert's full border paint onto the bar's open sides. One semantic palette (§3) plus the z-ladder (§4) is what keeps both from returning.

**"No email provider configured" labeling.** When no real email provider is set up — internally the dev `fake` transport, which records a send but delivers nothing — a confirmation like "Test sent to 2 addresses" or "Queued — cancelable for 5 minutes" would otherwise read exactly like a real send. So the send-action confirmations (test, schedule, send now) carry a `(no email provider configured — nothing is delivered)` suffix on their Toast, and the Sends page carries a persistent `.muted` descriptor saying the same of the record itself. The user-facing copy deliberately avoids the internal "fake transport" term; **"No email provider configured" is the catch-all voice** for this state. Both read from the same read-only deployment reflection as the "Local dev" identity chip, and — like it and the dev-only "Open dashboard" shortcut noted in the intro — are structurally absent once deployed, where the provider is SES/Resend. This is chrome about *how* mail was sent, never part of the frozen issue record (SPEC I3). A later issue will make this notice environment-aware (local / demo / production) and turn the new-user case — clicking "Send test email" before setup — into a dismissible notice that links to the setup docs; that is a different notification kind (an actionable, persistent notice, not a transient Toast) and gets its own pass.

---

## 3. Tokens — one meaning each

A token means one thing, and a color has one job; a second token for a color that already has one is how the interface drifts. The palette, at a glance:

| Token(s) | Role | Notes |
| --- | --- | --- |
| `--danger` · `--warn` · `--ok` | Semantic feedback — a `{fg, bg, line}` triple each: red · amber · green | One scale per meaning. `--danger` serves both a solid-button fill and the soft alert — one red, not two; the earlier split (`--danger` vs a separate `--b-bad-*`) caused a stray-red-border bug. |
| `--accent` (+ `--accent-on`, `--accent-soft`) | The one **action** hue — a fixed slate-blue | Primary + Secondary buttons only, never a status. Independent of the reader-surface theme (SPEC §8) — the app's own chrome, not the newsletter's. |
| `--ink` | Strong near-black/near-white **text** — headings, strong labels | Never a button fill. Renamed from `--accent`, which once doubled as a fill; there is one accent, and it is blue. |
| `--status-draft` · `--status-scheduled` · `--status-sending` · `--status-sent` | Lifecycle badge hues — gray · violet · blue · green | Facts, not warnings; distinct from the feedback scales. `--status-sending`'s blue is its own shade, **not** the action `--accent`. Full state→hue map below. |
| `--fg` `--muted` `--line` `--line-soft` `--chip` `--bg` `--card` | Neutral surface set | Text, borders, page/card grounds, and the recessed layer. |
| `--ring` | Focus | The one focus treatment. |
| `--syntax-*` | Editor syntax highlight — the **template** editor (HTML/CSS, `.cx-*`) and the **post/Markdown** editor (`.cx-md-*`) | One palette both editors' token classes map onto. The post editor's scheme is deliberately minimal — the *mark* is colored (`#` crimson `--syntax-heading`, `*`/`**` pink `--syntax-emphasis`, `>`/bullets orange `--syntax-quote`), the *content* keeps `--syntax-fg` and carries only weight/slant. This palette is self-contained: new syntax hues live here with a light + dark value each, and are otherwise out of scope for this contract's one-color-per-role rule. |

Every token has a light and a dark value; a color defined in only one theme is a bug.

**Badges — one hue per state; a semantic scale is reused only when the state's meaning *is* that feedback.** Post lifecycle states carry their own `--status-*` hue; subscriber consent states borrow the hue whose meaning fits. The full mapping, so an overload shows up here instead of hiding in the CSS:

| Badge | Scale | Hue |
| --- | --- | --- |
| post `draft` · subscriber `unsubscribed` | `--status-draft` | gray |
| post `scheduled` | `--status-scheduled` | violet |
| post `sending` | `--status-sending` | blue |
| post `sent` · subscriber `confirmed` | `--status-sent` | green |
| subscriber `pending` | `--warn` | amber |
| post `canceled`/`failed` · subscriber `suppressed` | `--danger` | red |

The four lifecycle hues (draft gray, scheduled violet, sending blue, sent green) are *facts*, kept distinct from the `danger`/`warn`/`ok` feedback scales — a `scheduled` badge is neither good nor bad. Reusing a feedback scale is allowed only when the state genuinely carries that reading: `failed`/`canceled`/`suppressed` → `danger`, and `pending` (awaiting double-opt-in) → `warn` amber — the same "one red, one amber" economy as above, not a conflation. The rule this encodes: `pending` takes `warn`, **never** `--status-sending`. The two coincided only while `--status-sending` was itself amber; when the dispatch treatment went blue, the `pending` pill went blue with it until it was repointed at `warn` — a token doing double duty is exactly the drift this section exists to catch.

The badge belongs in the lists and the **sent record view**, not the editor head: the editor only ever opens a draft or a scheduled (frozen) post — a sent issue routes to its record view instead (SPEC §8) — and both editor states are already signaled (the editable layout; the scheduled banner, §2 home ③), so the editor carries no status pill. The sent record view is where the delivery-outcome counts appear in **full** — every bucket, reconciled to the frozen audience — and they read in the **semantic feedback** scales (delivered `ok`, bounced `warn`, complained `danger`) — a genuine good/bad reading of how the send landed — while the `sent` badge beside them stays a lifecycle fact. The two scales sitting together there is exactly why they must not be conflated. The send lists (the Sent-issue table, the dashboard's recent sends) compress the same outcomes to a glance: a **Delivered** cell that is the *confirmed-delivered* count — never provider-accepted — with any complaints, bounces, or send-time failures as a muted note **beneath** it, worst first, in words rather than swatches — the record's tiles carry the colors; a clean send prints nothing there. Because both read from the one set of denormalized counters, a list and a record can never tell different stories about the same send (SPEC §8). The **per-recipient rows** listed beneath those tiles (SPEC §8) carry the same reading down to the row: each row's outcome cell reuses the very swatch palette of the tiles (`sw-ok` / `sw-warn` / `sw-danger`, plus `sw-sending` for an accepted-not-yet-confirmed row and `sw-neutral` for a failed/skipped one), so a row reads the same bucket as its tile and the record adds **no new token** — a bounce row further splits *soft* from *hard* by the kind frozen on that row for this send (SPEC §8), not by a color and not by the mutable suppression list.

**The in-flight watch adds no palette — it reuses these scales.** A **phase pill** borrows the matching lifecycle or feedback tone; **two progress bars share one scale** (the frozen audience is the denominator for both) — a **dispatch** bar in the `sending` hue, and a **delivery** bar beneath it pairing a neutral-grey `accepted` frontier with the `ok` green `confirmed` filling in behind, so delivery always reads as *lagging* dispatch; and **active-send cards** (dashboard widget, Sent "In progress" row) in the `sending` hue, as scheduled cards are violet. So `--status-sending` is the single "in flight" cue across badge, pill, bars, and cards — including the in-flight post's **Drafts-list** label, which routes to the watch, not the editor (SPEC §8).

---

## 4. Layering — one z-index ladder

Stacking is a single named ladder, and every fixed or floating surface references a rung by token — never a bare z-index literal. Six rungs, in order:

| Rung | Token | What sits here |
| --- | --- | --- |
| 1 | `--z-content` | Normal page content. |
| 10 | `--z-header` | Sticky headers and the side rail. |
| 20 | `--z-menu` | Popovers and menus. |
| 30 | `--z-bar` | Fixed bars — the save bar. |
| 40 | `--z-toast` | Toasts. |
| 50 | `--z-modal` | Modals and their backdrop overlay. |

The order encodes the intent: a menu opens over the content and headers; a fixed bar sits above the content it's saving; a toast confirms above that bar; a modal takes the whole screen and sits above everything. Because features reference the rung and not a number, the ladder is the one place stacking is reasoned about — a new floating surface picks the rung whose meaning fits and inherits a consistent order, instead of guessing a literal that happens to be higher than its neighbor today.

---

## 5. Save models — two, and every surface picks one

There are exactly two ways a surface saves, and a surface commits to one of them whole. Mixing them — an autosave surface that also shows a save bar, or an explicit-save surface that silently persists — is the confusion this section rules out.

**Model A — explicit save.** The surface has a revertible baseline: edits accumulate against the last-saved state, and the reader commits or discards them deliberately. Its home is the shared bottom **save bar** (§2, home ②), which shows unsaved/saving/saved, carries Save and Revert, and owns its own blocking error in-bar. Used by **Settings** and the **email Template** surfaces.

Within Settings, the **confirmation email** section (SPEC §7) is **preview-first**: its resting state is the rendered email, and an icon-labelled **Preview | Edit** toggle — a Control (§1), the section's primary control and so a step more prominent than the plain preview-width toggle — sits at the left of the preview bar (in place of a text label) and flips the framed area to the words-only fields and back. There is no style toggle: the email always leads with the publication masthead (SPEC §7), which degrades to plain on its own, so the operator edits words, never a layout. Because it's words — not author-supplied HTML the way the issue Template is — it edits **in place** rather than opening a room of its own: the weight of the surface, not a second pattern. It commits through the shared save bar like the rest of Settings; the toggle only changes what you're looking at and never commits.

**Model B — continuous autosave.** The surface persists as you type, with no commit step. Its feedback is the inline **autosave cue** (§2, home ⑤) for the save lifecycle and the **editor-state banner** (home ③) for a `conflict` when the draft changed elsewhere. It does **not** use the save bar. Used by the **post editor**, whose autosave-plus-conflict model is the reason the save bar deliberately excludes it.

The two models are held distinct on purpose: the editor needs continuous persistence and cross-writer conflict handling that the save bar has no vocabulary for, while Settings and Template need a clear commit/revert boundary that autosave would erase. New surfaces choose A or B by that question — is there a meaningful "unsaved draft" the reader should be able to revert? — and adopt that model's home for feedback, rather than assembling a third.

A **read-only** surface picks neither, because there is nothing to save. The **sent record view** (SPEC §8) is the case in point: a sent issue is a frozen record (I3), so the surface has no editable field, no save bar, and no autosave cue — its only controls are ways to *look* or ways *out*: a link to the published issue, a CSV export of the delivery record, and the **per-recipient rows** listed beneath the outcome tiles, whose **Issues / Delivered / All** switch is a view **Toggle** (a Control, §1 — it changes what you're looking at, never commits an action) and whose search and pager only re-query the frozen record. Read-only for the operator is not the same as static, though: the outcome tiles are the record's **living layer** — they go on settling as this send's delivery receipts arrive (SPEC §8) — so a muted caption above them marks what keeps moving apart from the render and audience, which are frozen (I3). Inspecting a record more closely is still reading it, so none of these change it. "Every surface picks A or B" is scoped to surfaces that edit state; a surface that only displays a record answers the §5 question with "there is no draft here at all."

The record view's **in-flight watch** state (the same page while a send is still sending, SPEC §8) is read-only in the same sense — there is no draft and no save. It differs only in being **live**: it polls the progress endpoint (a faster cadence while dispatching, slower while settling) and clears that poll on navigation, the same discipline as the editor's freshness poll and the scheduled countdowns. It is observe-only but for one control — **Resolve**, the operator's adjudication of a wedged send (SPEC §11) — which is the view's Primary while it applies and absent otherwise; polling and a live view are not a save model, so the watch still "picks neither."

---

## 6. Narrow viewports — one layout per list

The admin UI gets opened on a phone — often just to check that an issue went out — so every surface holds at any width, and a list never makes you scroll sideways to read its lead column. Below 720px a list table takes `.stacks`: each row collapses to its lead cell (title, subject, email) on its own line, then the rest as one muted meta line, with the row's ⋯ menu at top-right; the column headers and their sort controls drop, while search and the toolbar filters stay. It is the desktop table's own markup restyled — not a second render — so the two can't drift, and a new list opts in with the class rather than a layout of its own. (The record's per-recipient table is the one holdout: it scrolls sideways instead of stacking.)
