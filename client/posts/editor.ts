// The post editor: the subject, the Markdown composer, Post settings, autosave with its idle and
// hard-cap timers, the freshness poll, images, the schedule / send-now dialogs, and a
// scheduled post's banner, which follows its send until the send page takes over.

import { DAILY_WRITES_SEND_RECIPIENTS, dailyWritesSendWarning } from "../../shared/free_plan";
import {
  IMAGE_TYPE_BY_EXTENSION,
  type ImageUploadResponse,
  imageTypeOfName,
} from "../../shared/images";
import type {
  PostEditBody,
  PostResponse,
  PostSavedResponse,
  PostSettingsBody,
  PostSettingsResponse,
  PreviewResponse,
  TestSendResponse,
} from "../../shared/posts";
import {
  refusingSendWarning,
  SANDBOX_SEND_WARNING,
  type ScheduleResponse,
  type SendAction,
  type SendResponse,
  type SendView,
} from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import { slugify } from "../../shared/slug";
import type { SubscriberListResponse } from "../../shared/subscribers";
import { ApiError, api, describeError, isNetworkFailure } from "../api";
import {
  connectProviderLink,
  dailyWritesLine,
  heldWhenFiresHtml,
  isTooSoon,
  notConnectedScheduleLine,
  notConnectedTestLine,
  notConnectedWarning,
  providerNotConnected,
  refusingSendLine,
  sandboxSendLine,
  sendNowWhenText,
  tooSoonText,
  withNoProviderNote,
} from "../deployment";
import { at, every, mount, onAbort, poll, setTitle, type ViewHandle } from "../lifecycle";
import { inSandbox, readProviderStatus, refusalOf } from "../provider_status";
import { followSend, readSendsNow, type StageChange } from "../send_state";
import { openRescheduleModal } from "../sends/dialogs";
import { can, conditionOf, has } from "../sends/progress";
import { mountWhen, scheduledText, type WhenPicker, whenHtml } from "../sends/when";
import { appState } from "../state";
import { clocksFor, noTimeZoneLine } from "../time_zone";
import { $, $$ } from "../ui/dom";
import { EMAIL_FRAME_SANDBOX, openLinksInNewTab } from "../ui/email_frame";
import {
  fmtAt,
  invalidAddressesMessage,
  lateStr,
  notSentMessage,
  parseAddresses,
  secondClock,
  type TestMiss,
  toLocalInput,
  untilStr,
} from "../ui/format";
import { highlightMarkdown } from "../ui/highlight";
import { type Html, html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { busy, fieldError, modal, renderError, toast } from "../ui/widgets";
import { bannerActedBy, whoActed } from "../who_acted";
import { activeSend, postAction } from "./actions";
import { createAutosave } from "./autosave";
import { carryOffset } from "./caret";
import { DirtyTracker } from "./dirty";
import { showDropCaret } from "./drop_caret";
import { formatEdit } from "./format";
import { insertImage } from "./images";
import { openImagesDialog } from "./images_dialog";
import { LatestRender, type Render } from "./latest_render";
import { trackSaves } from "./pending_save";
import {
  destinationHtml,
  destinationIcon,
  mountSettingsForm,
  type Publishing,
  publishingOf,
  settingsChange,
  showSlugRefusal,
} from "./publishing";
import { answerNewer, type Conflict, conflictFromError, RevisionTracker } from "./revisions";
import { replaceRange } from "./text_edit";
import {
  insertPlaceholder,
  placeholderFor,
  replacePlaceholder,
  type TextEdit,
  type TextState,
  uploadRefusal,
} from "./uploads";
import { previewOpensWebVersion, webVersionHash } from "./web";

const message = describeError;

const TOOLBAR: [IconName, string][][] = [
  [
    ["heading", "Heading"],
    ["bold", "Bold (⌘B)"],
    ["italic", "Italic (⌘I)"],
  ],
  [
    ["quote", "Quote"],
    ["code", "Code"],
    ["link", "Link (⌘K)"],
    ["image", "Images"],
  ],
  [
    ["ul", "Bulleted list"],
    ["ol", "Numbered list"],
    ["indent", "Indent"],
  ],
];

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
const READONLY = html` readonly`;
const HIDDEN = html` hidden`;
const ARIA_DISABLED = html` aria-disabled="true"`;

type ComposerTab = "edit" | "preview";

/**
 * How a save ended. `saved` and `unchanged` both mean the server holds what the editor
 * shows. `refused` means it does not: another writer's revision is newer, so the save was
 * rejected (or is paused behind the out-of-date banner), and an action that would freeze
 * the content — schedule, send now (SPEC §6, I3) — must not proceed on the publisher's
 * behalf. A plain failure throws instead of answering.
 */
type SaveResult = "saved" | "unchanged" | "refused";

export async function renderEditor(
  id: string,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<ViewHandle | undefined> {
  // Reload, cancel-schedule, and error-retry re-enter through mount(), which tears this
  // mount down (its autosave, its freshness poll) before the next one starts.
  // (A retry or reload click reaches this from a live root; a re-entry after a write the
  // reader did not stay to watch, such as a cancel that landed after they left, must not
  // mount the editor over wherever they went.)
  const remount = () => {
    if (!signal.aborted) {
      mount((r, s) => renderEditor(id, r, s));
    }
  };
  // The post was deleted elsewhere (another tab, or Claude through the API), found by
  // whichever read or write answers 404 first: say so once and go to Drafts. Deleting a
  // post is deliberate, and autosave keeps what is unsaved to the last few seconds of
  // typing, so the editor doesn't stay open to hold it.
  let gone = false;
  const removed = (msg = "This post was deleted elsewhere.") => {
    if (gone) {
      return;
    }
    gone = true;
    toast(msg);
    if (!signal.aborted) {
      handOff("#/drafts");
    }
  };
  setTitle(signal, "Draft");
  setHtml(root, html`<p class="muted">Loading…</p>`);
  let data: PostResponse;
  // A scheduled post's send, as the send routes report it: the banner's countdown and
  // conditions, and the cursor the editor follows the send from.
  let sendRead: SendResponse | null = null;
  try {
    data = await api<PostResponse>(`/api/posts/${id}`, { signal });
    if (signal.aborted) {
      return; // navigated away while loading: the redirects below must not hijack that
    }
    // A sent post is a frozen record, not editable: it opens the sent record view, never
    // the editor. Redirect a stale #/edit link (or a post sent in another tab / by Claude)
    // there instead of a locked editor. A post whose send is in flight is no longer an
    // editable, cancelable scheduled draft but an active send, so its link opens the live
    // watch, not a soft-locked editor with a dead Cancel.
    const home = sendHome(data);
    if (home) {
      handOff(home);
      return;
    }
  } catch (e) {
    // A Retry can only fail again for a post that isn't there (gone since the last read,
    // or a link to one that never was), so it goes to Drafts instead.
    if (isNotFound(e)) {
      removed("There’s no post here. It may have been deleted.");
      return;
    }
    renderError(root, message(e), remount);
    return;
  }
  // The post's send while it is scheduled (a post going out was handed off above).
  const scheduled = activeSend(data.post);
  if (scheduled) {
    try {
      sendRead = await api<SendResponse>(`/api/sends/${scheduled.id}`, { signal });
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      // A send is deleted only with its post, so the post went between the two reads.
      if (isNotFound(e)) {
        removed();
        return;
      }
      // Any other failure leaves the post readable: the editor opens with its banner from
      // the post's own read, and follows the send once a later read of it succeeds.
    }
    if (signal.aborted || (sendRead && movedOn(sendRead.send, remount))) {
      return;
    }
  }
  const { post, markdown } = data;
  const you = appState.session?.principal ?? null;
  // The post's publishing settings as stored (SPEC §4, §5): whether it is included in the
  // archive, and its archive address. Neither is part of the email, so both change while the
  // post is scheduled too, through Post settings, and a dialog's edits reach them only on Save,
  // Schedule, or Send now.
  let pub = publishingOf(post, data.subject_slug_held);
  // What the server would take for the post now, from its latest read or save: a time zone set
  // or a provider connected since the editor opened reaches the dialogs without a reload.
  let actions = post.actions;

  // The editor now only ever mounts a draft or a scheduled (frozen) post, so `locked`
  // means scheduled, signaled by the scheduled banner, not a status pill. Whether its text
  // can be saved is the server's to say, in the post's `actions`.
  const locked = !postAction(post, "edit");
  // Whether the server would take a schedule or a send now: a draft, while a provider is
  // connected and a time zone set. The dialog offers both views only then (DESIGN §4), read
  // as it opens.
  const canSend = () => postAction({ actions }, "schedule") !== undefined;
  // The revision this editor is based on, for optimistic concurrency (SPEC §4).
  // Advanced on each successful save; carried on every save so the server rejects
  // (409) rather than clobbers a newer save from another tab or from Claude.
  const revisions = new RevisionTracker(post.current_revision);
  // A scheduled post keeps its formatting toolbar in view, greyed. The buttons take
  // aria-disabled rather than disabled so a click still reaches applyFormat, whose locked
  // branch nudges the foot line, the way out (DESIGN §3).
  const toolbarHtml = TOOLBAR.map(
    (group, i) =>
      html`${i ? html`<span class="sep"></span>` : null}${group.map(
        ([kind, label]) =>
          html`<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}"${locked ? ARIA_DISABLED : null}>${icon(kind)}</button>`,
      )}`,
  );
  // readonly, not disabled: a scheduled post's text can still be read, selected, and
  // copied; only a change is refused (DESIGN §3).
  const ro = locked ? READONLY : null;
  // The web version's address (SPEC §5), whole, so it opens as its own page. It differs
  // from this one only in the hash, which is what keeps a save safe when the link opens in
  // place (below).
  const webVersionUrl = `${location.origin}${location.pathname}${webVersionHash(id)}`;

  setHtml(
    root,
    html`
    <div class="editor-head">
      <a href="#/drafts" class="back">← Drafts</a>
      <div class="editor-head-right">
        <span class="email-only-mark" id="headEmailOnly"${post.email_only && !locked ? null : HIDDEN}>${icon("mail")}Email only</span>
        <a class="ghost btn" id="webLink" href="${webVersionUrl}" target="_blank" rel="noopener" aria-label="Web version (opens in a new tab)">Web version ↗</a>
        <button type="button" class="ghost" id="settingsBtn">${icon("settings")}<span>Post settings</span></button>
      </div>
    </div>
    ${locked && scheduled ? html`<div class="banner banner-scheduled banner-split"><div class="banner-top"><div class="sched-main"><span id="schedWhen"></span><div class="sched-by" id="schedBy" hidden></div>${heldWhenFiresHtml("banner")}<div class="sched-remade" id="schedRemade" hidden><span id="schedRemadeMsg"></span></div><div class="sched-note" id="schedDailyWrites" hidden><span class="sched-note-mark" aria-hidden="true">⚠️</span><span class="sched-note-msg" id="schedDailyWritesMsg"></span></div><div class="sched-note" id="schedSandbox" hidden><span class="sched-note-mark" aria-hidden="true">⚠️</span><span class="sched-note-msg" id="schedSandboxMsg"></span></div><div class="sched-note sched-note-refusing" id="schedRefusing" hidden><span class="sched-note-mark" aria-hidden="true">⚠️</span><span class="sched-note-msg" id="schedRefusingMsg"></span></div></div><span class="row" id="schedControls"><button type="button" class="ghost" id="rescheduleSchedule">Edit schedule</button><button type="button" class="ghost" id="cancelSchedule">Cancel</button></span></div><div class="banner-bottom sched-dest"><span class="sched-dest-icon" id="schedDestIcon">${destinationIcon(pub)}</span><span id="schedDest">${destinationHtml(pub)}</span></div></div>` : null}
    <div id="freshnessBanner" class="banner banner-conflict" role="alert" hidden></div>
    <div class="editor-form">
      <label for="f-subject">Subject</label>
      <input id="f-subject" value="${post.subject}" placeholder="Untitled"${ro}>

      <label for="f-markdown">Body</label>
      <div class="composer${locked ? " composer-locked" : ""}">
        <div class="composer-head">
          <div class="ctabs" role="tablist">
            <button type="button" class="ctab active" data-tab="edit" data-text="Edit" role="tab" aria-selected="true"><span class="ctab-label">${icon("editable")}Edit</span></button>
            <button type="button" class="ctab" data-tab="preview" data-text="Preview" role="tab" aria-selected="false"><span class="ctab-label">${icon("preview")}Preview</span></button>
          </div>
          <span class="preview-status" id="previewStatus" role="status"></span>
          <div class="toolbar" role="toolbar" aria-label="Formatting">${toolbarHtml}</div>
        </div>
        <div class="composer-body${locked ? " locked" : ""}" id="composerBody">
          <div class="md-scroll" id="mdScroll">
            <div class="md-stack">
              <pre class="md-hl" id="mdHl" aria-hidden="true"><code></code></pre>
              <textarea id="f-markdown" class="editor"${locked ? null : html` placeholder="Type your post in Markdown…"`}${ro}>${markdown}</textarea>
            </div>
          </div>
          <iframe class="preview" sandbox="${EMAIL_FRAME_SANDBOX}" title="Email preview" hidden></iframe>
          <iframe class="preview staging" sandbox="${EMAIL_FRAME_SANDBOX}" title="Email preview" hidden></iframe>
        </div>
        ${
          locked
            ? html`<div class="composer-foot composer-foot-lock" id="lockFoot" role="status">${icon("readonly")}<span>Cancel the schedule to edit</span></div>`
            : html`<div class="composer-foot" id="dropFoot">${icon("paperclip")}<span aria-live="polite">Paste, drop, or click to add images</span></div>`
        }
        <input type="file" id="imgInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
      </div>
      <div id="warnings"></div>
      ${locked ? null : notConnectedWarning("editor-not-connected", html`No email provider connected: you can write and preview, not send. ${connectProviderLink()}.`)}

      <div class="actions-bar">
        ${
          locked
            ? html`<div class="row test-row"><span class="test-hint" id="testHint" hidden>Not tested yet</span><button type="button" class="secondary" id="testBtn">${icon("send")}<span>Send test email</span></button></div>`
            : html`<div class="row">
                 <button type="button" class="ghost" id="saveBtn">Save draft</button>
                 <span class="save-status" id="saveStatus" aria-live="polite"></span>
               </div>
               <div class="row">
                 <button type="button" class="secondary" id="testBtn">${icon("send")}<span>Send test email</span></button>
                 <button type="button" class="primary" id="scheduleBtn">Schedule</button>
               </div>`
        }
      </div>
    </div>`,
  );

  const subjectEl = $<HTMLInputElement>("#f-subject");
  // The tab carries the subject, kept to the field as it is typed, so a post open beside
  // others is the one its tab names.
  const nameTab = () => setTitle(signal, subjectEl.value.trim() || "Untitled");
  nameTab();
  const ta = $<HTMLTextAreaElement>("#f-markdown");
  const toolbarEl = $(".toolbar", root);

  // Syntax-highlight overlay: a transparent <textarea> over a highlighted <pre>, the template
  // editor's scaffolding, tokenizing Markdown. Prose soft-wraps, so both layers share pre-wrap
  // and identical metrics (the caret lands on the colored text); that wrapping is also why
  // there's no line-number gutter — a number can't track a wrapped line and prose doesn't want
  // one. The highlight is the point.
  // Neither layer scrolls: the <pre> is as tall as the text and the textarea is stretched over
  // it, and the box around both (#mdScroll) is the one scroller. A textarea scrolled on its own,
  // with the <pre> following from its scroll event, is a frame or more behind it, since the
  // browser moves the textarea off the main thread before the event runs.
  const mdScroll = $("#mdScroll");
  const mdHlCode = $("#mdHl code");
  const paintMarkdown = () => {
    // highlightMarkdown emits one block row per source line (split on "\n"), so the row count —
    // and thus the stack's height, which the textarea takes — tracks the text, including a
    // trailing blank line.
    setHtml(mdHlCode, highlightMarkdown(ta.value));
  };
  paintMarkdown(); // paint the initial content (a scheduled post is read-only but still highlighted)

  // A save carries the subject and the body. The archive address is a publishing setting, set
  // in Post settings: a slug that follows the subject is derived again by the server on each
  // save, which answers with it (SPEC §4).
  const collect = () => ({ subject: subjectEl.value, markdown: ta.value });

  // --- subject validation (SPEC §6: freeze() rejects a subjectless send) ---
  // Surfaced on the field, not by disabling the button. The old guard greyed out
  // Schedule and hung the reason in a `title` on the row — invisible to keyboard,
  // touch, and screen readers. Instead Schedule stays live and we validate on click:
  // an empty subject puts the input into an error state with the reason directly
  // beneath it (DESIGN §5), tied by aria-describedby and announced (role=alert).
  let clearSubjectErr: (() => void) | null = null;
  function clearSubjectError() {
    clearSubjectErr?.();
    clearSubjectErr = null;
  }
  // Gates both send paths (the scheduled send and the in-modal Send now both open
  // from Schedule): true when a subject is present; otherwise shows the error, moves
  // focus to the field, and returns false so the modal never opens.
  function validateSubject() {
    if (subjectEl.value.trim() === "") {
      clearSubjectErr = fieldError(subjectEl, "Add a subject before you schedule.");
      subjectEl.focus();
      return false;
    }
    clearSubjectError();
    return true;
  }

  // --- Post settings (DESIGN §3): whether the post is in the archive, and its address ---
  // A draft's head marks only the exception, a post left out of the archive; a scheduled post's
  // banner names where it is going instead, on a row of its own under the time and the notes
  // about sending, apart from the controls that act on the time. The settings themselves
  // are in a dialog that saves nothing until Save.
  const headEmailOnly = $("#headEmailOnly");
  const paintPublishing = () => {
    // A scheduled post's banner names where it is going, so the head's mark is a draft's.
    headEmailOnly.hidden = locked || !pub.emailOnly;
    const destIcon = root.querySelector<HTMLElement>("#schedDestIcon");
    if (destIcon) {
      setHtml(destIcon, destinationIcon(pub));
    }
    const dest = root.querySelector<HTMLElement>("#schedDest");
    if (dest) {
      setHtml(dest, destinationHtml(pub));
    }
  };
  /** Take the post's settings and actions from a read or write of it, whichever client last
   *  changed them: a settings change writes no revision, so it arrives on any answer. */
  const adopt = (p: PostResponse["post"], held: PostResponse["subject_slug_held"]) => {
    pub = publishingOf(p, held);
    actions = p.actions;
    paintPublishing();
  };
  /** Save a change to the post's settings (`PUT /api/posts/:id/settings`), and show what the server made
   *  of it. Throws the refusal, for the dialog that asked to say it. */
  const saveListing = async (body: PostSettingsBody): Promise<void> => {
    const res = await api<PostSettingsResponse>(`/api/posts/${id}/settings`, {
      method: "PUT",
      json: body,
    });
    adopt(res.post, res.subject_slug_held);
    if (res.changed) {
      readSendsNow(); // the post's sends carry the listing: let every view see it
    }
  };
  /** Read the post's settings again, for a change made elsewhere; a failed read leaves what
   *  the page shows, and the next report tries again. */
  const rereadPublishing = async () => {
    try {
      const fresh = await api<PostResponse>(`/api/posts/${id}`, { signal });
      adopt(fresh.post, fresh.subject_slug_held);
    } catch {}
  };
  $("#settingsBtn").onclick = () => {
    // A working copy: Cancel, Escape, or a click outside leaves the post as it was. On a draft
    // the subject in the field is the one the address would follow. Save sends only what was
    // changed from the settings as the dialog opened, so a change made elsewhere meanwhile stands.
    const opened = pub;
    const working: Publishing = { ...pub, subject: subjectEl.value };
    const m = modal(
      html`<h3 id="psHead">Post settings</h3><p class="hint">Neither is part of the email, so both stay open while the post is scheduled.</p><div id="psForm"></div><div class="actions"><button type="button" id="psCancel">Cancel</button><button type="button" class="primary" id="psSave">Save</button></div>`,
      signal,
    );
    const box = $(".modal", m.el);
    box.setAttribute("aria-labelledby", "psHead");
    mountSettingsForm($("#psForm", box), working, "ps");
    $("#psCancel", box).onclick = m.close;
    const save = $<HTMLButtonElement>("#psSave", box);
    save.onclick = () =>
      busy(save, "Saving…", async () => {
        m.clearError();
        const body = settingsChange(opened, working);
        if (!body) {
          m.close();
          return;
        }
        try {
          await saveListing(body);
          m.close();
          toast("Post settings saved");
        } catch (e) {
          if (signal.aborted || foundGone(e)) {
            m.close();
            return;
          }
          if (!showSlugRefusal(box, "ps", e)) {
            m.error(message(e));
          }
        }
      });
    $<HTMLInputElement>("#psInclude", box).focus();
  };

  // Clear the empty-subject error as soon as a real subject is typed; it re-fires on the next
  // Schedule click if the field is still empty (see validateSubject).
  if (!locked) {
    subjectEl.addEventListener("input", () => {
      nameTab();
      if (subjectEl.value.trim() !== "") {
        clearSubjectError();
      }
    });
  }

  // Autosave (./autosave.ts): save after a quiet pause, but never let an edit sit
  // unsaved longer than the hard cap. Manual Save + ⌘S stays the primary path; this is
  // the safety net. Failures surface as a toast, never silently. Cancelled with the mount,
  // so a navigation or the re-auth wall ends it. Declared before any path that can save
  // (the Preview tab saves first), since saveDraft cancels it.
  const mine = createAutosave(() => {
    saveDraft(true).catch(() => {}); // the save cue says why
  });
  onAbort(signal, () => mine.cancel());

  // --- tabs ---
  const tabs = $$<HTMLButtonElement>(".ctab", root);
  let tab: ComposerTab = "edit";
  function showTab(name: ComposerTab) {
    tab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
    ta.hidden = name !== "edit";
    mdScroll.hidden = name !== "edit"; // the highlight layer travels with the textarea
    front.hidden = name !== "preview";
    toolbarEl.classList.toggle("off", name !== "edit");
    // The image foot dims with the toolbar: a click on Preview would insert into a hidden
    // textarea behind a preview that doesn't change. A drop still lands (it switches to Edit).
    root.querySelector("#dropFoot")?.classList.toggle("off", name !== "edit");
    if (name === "edit") {
      previewRound += 1; // the look at Preview is over
    }
    paintPreview();
  }

  const warningsEl = $("#warnings");
  function showWarnings(ws: string[] | null | undefined) {
    setHtml(
      warningsEl,
      ws?.length
        ? html`<div class="warnings"><strong>Warnings:</strong> ${ws.join(" ")}</div>`
        : html``,
    );
  }

  // --- the preview ---
  // The Preview tab shows the server's render of what is saved (I5), fetched ahead: after each
  // save, and when the pointer or focus reaches the tab, so a click usually finds it ready
  // (./latest_render.ts). Two frames take turns: `front` is the one the tab shows, and `back`
  // loads the next render out of sight, swapping in only once it has loaded and been sized, so
  // the email never blanks or jumps. A render that isn't of the text on screen is never shown as
  // the current one: it is dimmed, under "Updating…" until the fresh one swaps in, or under "Not
  // up to date" when none is coming (the render failed, or saving is paused by the out-of-date
  // banner, which shows the other writer's version).
  let [front, back] = $$<HTMLIFrameElement>("iframe.preview", root) as [
    HTMLIFrameElement,
    HTMLIFrameElement,
  ];
  const previewStatus = $("#previewStatus");
  const renders = new LatestRender(async () => {
    // The page and what the render found wrong with it (a broken image reference reads as text
    // in the email itself) come from one render, which names the revision it is of.
    const {
      revision_id: revision,
      html: page,
      warnings,
    } = await api<PreviewResponse>(`/api/posts/${id}/preview.json?include=html`, { signal });
    if (page === undefined) {
      throw new Error("The preview came back without its page.");
    }
    return { revision, html: page, warnings };
  });
  let shown: Render | null = null; // in `front`
  let loading: Render | null = null; // loading in `back`
  let previewFailed = false;
  // Each look at Preview since the editor mounted, counting a move back to Edit as the end of
  // one, so a look the publisher has left doesn't report on itself late.
  let previewRound = 0;
  /** The key of what is saved: its revision ("" for a post never saved since it had one). While
   *  the out-of-date banner is up, what is saved is the other writer's newer revision. */
  const savedKey = () =>
    (locked ? post.current_revision : (revisions.warnedRevision ?? revisions.base)) ?? "";
  /** The saved revision the text on screen is, or null while an edit is unsaved, a save is in
   *  flight, or a save is paused by the out-of-date banner. */
  function savedRevision(): string | null {
    return !locked && (dirty.dirty || saving || conflicted) ? null : savedKey();
  }
  /** Whether the front frame is the render of what is saved now. */
  function previewCurrent(): boolean {
    return shown !== null && shown === renders.latest && shown.revision === savedRevision();
  }
  function paintPreview() {
    const current = previewCurrent();
    const updating = tab === "preview" && !current;
    front.classList.toggle("updating", updating);
    const stuck = previewFailed || (!locked && conflicted);
    previewStatus.textContent = !updating ? "" : stuck ? "Not up to date" : "Updating…";
    // The line under the composer shows on either tab, so it follows every render of what is
    // saved, the one rendered ahead after a save included: fixing the text clears it once the
    // save's render is in. While an edit is unsaved or the out-of-date banner is up, no render
    // is of the text on screen, so it keeps the last one's words rather than flicker with each
    // keystroke; the next save's render replaces them.
    if (current && shown) {
      showWarnings(shown.warnings);
    }
  }
  /** Load `r` into the back frame, out of sight; once it has loaded it is sized and swapped in. */
  function stage(r: Render) {
    if (shown === r || loading === r) {
      return;
    }
    loading = r;
    const frame = back;
    frame.style.height = "";
    frame.classList.add("staging");
    frame.hidden = false;
    // The page in the frame now: its first empty one, or an older render still loading its
    // images. Either can answer before this render's does, so only a new page counts.
    const before = frame.contentDocument;
    frame.onload = () => {
      const doc = frame.contentDocument;
      if (loading !== r || frame !== back || doc === before || doc?.URL !== "about:srcdoc") {
        return; // or a newer render took this frame over
      }
      loading = null;
      let height = "";
      try {
        if (doc) {
          openLinksInNewTab(doc);
          // The email's link is the post's unlisted link, which never changes. The
          // editor holds only an unpublished post: once its send starts, the editor hands
          // off to the send page (and a web version opened after that goes on to the
          // public page itself).
          previewOpensWebVersion(doc, post.unlisted_url, webVersionUrl);
          height = `${doc.body.scrollHeight + 24}px`;
        }
      } catch {}
      swap(r, height);
    };
    frame.srcdoc = r.html;
  }
  function swap(r: Render, height: string) {
    // The page scrolls, not the frame (it is as tall as the email), so a swap keeps every
    // scrolled ancestor where it was: a reader partway down stays there.
    const scrolled: [Element, number][] = [];
    for (let el = front.parentElement; el; el = el.parentElement) {
      if (el.scrollTop) {
        scrolled.push([el, el.scrollTop]);
      }
    }
    back.style.height = height;
    back.classList.remove("staging");
    back.hidden = tab !== "preview";
    front.hidden = true;
    front.classList.add("staging");
    front.classList.remove("updating");
    front.style.height = "";
    [front, back] = [back, front];
    for (const [el, top] of scrolled) {
      el.scrollTop = top;
    }
    shown = r;
    previewFailed = false;
    paintPreview();
  }
  /** Fetch the render of what is saved, if it isn't held already, and load it out of sight. */
  function renderAhead() {
    const revision = savedRevision();
    if (revision === null || previewCurrent()) {
      return;
    }
    renders
      .want(revision)
      .then((r) => r && stage(r))
      .catch(() => {}); // in the background; a click on Preview asks again and says why
  }
  async function showPreview() {
    showTab("preview");
    if (previewCurrent()) {
      return; // rendered ahead: shown as it is
    }
    const round = ++previewRound;
    previewFailed = false; // a new try: "Updating…" until it lands or fails
    paintPreview();
    if (!locked) {
      try {
        await saveDraft(true);
      } catch (e) {
        // A failed save is said on the save cue, its home (DESIGN §5); Preview says only that
        // what it shows isn't the text on screen.
        if (signal.aborted || foundGone(e) || round !== previewRound) {
          return;
        }
        previewFailed = true;
        paintPreview();
        return;
      }
    }
    try {
      // A write landing first (our own save's echo, a pause's flush, another writer) answers
      // with a render of another revision, which is dropped and asked for again.
      let r: Render | null = null;
      for (let tries = 0; !r && tries < 3; tries++) {
        r = await renders.want(savedKey());
      }
      // A render of a saved revision is safe to load whenever it lands: a swap marks it if it
      // isn't the text on screen.
      if (r) {
        stage(r);
      } else if (round === previewRound) {
        previewFailed = true; // the post kept changing under it: none of the tries can be shown
        paintPreview();
      }
    } catch (e) {
      if (signal.aborted || foundGone(e) || round !== previewRound) {
        return;
      }
      previewFailed = true;
      paintPreview();
      toast(message(e));
    }
  }
  for (const t of tabs) {
    t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("edit"));
  }
  const previewTab = $<HTMLButtonElement>(".ctab[data-tab='preview']", root);
  // The pointer reaching the tab, or focus landing on it, is the cue a click is coming: the
  // render starts then if no save started it. A press starts the save a click would, ahead
  // of the click.
  previewTab.addEventListener("pointerenter", renderAhead);
  previewTab.addEventListener("focus", renderAhead);
  previewTab.addEventListener("pointerdown", () => {
    if (!locked && tab === "edit" && dirty.dirty && !conflicted) {
      saveDraft(true).catch(() => {}); // the save cue says why; the click asks again
    } else {
      renderAhead();
    }
  });
  // A scheduled post opens on Preview: the preview is the copy that will send, and the
  // Edit tab is read-only, so it is somewhere the publisher goes deliberately and finds
  // the way out written on it (DESIGN §3).
  if (locked) {
    showPreview();
  }

  // --- the lock's nudge ---
  // A scheduled post refuses edits at the browser (readonly) and at the API (SPEC §6). When
  // one is attempted anyway, the foot's "Cancel the schedule to edit" pulses once, so the
  // way out is seen where the keystroke landed rather than announced elsewhere (DESIGN §3).
  const lockFoot = locked ? $("#lockFoot") : null;
  let nudgeTimer: number | undefined;
  function nudge() {
    if (!lockFoot) {
      return;
    }
    lockFoot.classList.remove("nudge");
    requestAnimationFrame(() => lockFoot.classList.add("nudge")); // a frame apart, so a second nudge restarts the pulse
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => lockFoot.classList.remove("nudge"), 900);
  }

  // --- formatting toolbar ---
  // What a button does to the text is posts/format.ts (each toggles); here it only lands, as
  // one edit the browser can undo.
  function applyFormat(kind: string) {
    if (locked) {
      nudge(); // reached by a toolbar click or a Cmd+B / I / K shortcut
      return;
    }
    if (kind === "image") {
      openImages();
      return;
    }
    showTab("edit");
    const edit = formatEdit(kind, {
      text: ta.value,
      start: ta.selectionStart,
      end: ta.selectionEnd,
    });
    if (edit) {
      replaceRange(ta, edit.start, edit.end, edit.insert, edit.select);
    }
  }
  for (const b of $$<HTMLButtonElement>(".tb[data-fmt]", root)) {
    b.onclick = () => applyFormat(b.dataset.fmt ?? "");
  }
  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      applyFormat("bold");
    } else if (k === "i") {
      e.preventDefault();
      applyFormat("italic");
    } else if (k === "k") {
      e.preventDefault();
      applyFormat("link");
    }
  });

  // --- unsaved-changes tracking + save ---
  // A snapshot of the last-saved field values; the editor is "dirty" whenever the
  // current values differ. We reflect that in a save-status indicator beside the
  // button, guard navigation (at the router, through the handle), and autosave.
  let editorDirty = false;
  // The last save errored, or the draft changed elsewhere (the out-of-date banner is up):
  // either way the leave guard prompts instead of silently flushing.
  let saveFailed = false;
  // The open Images dialog's notifier, called when the post's text may have changed under it.
  let imagesChanged: (() => void) | null = null;
  let conflicted = false;
  // Why the last save failed, in the publisher's words, kept on the save cue until a save
  // succeeds: a toast would be gone in seconds and leave the cue reading like ordinary
  // typing. A failed save tries again on its own, spaced out, so a dropped connection
  // recovers without another edit.
  let saveError: string | null = null;
  let retryDelay = 0;
  let retryArmed = false; // one pending retry at a time, however many saves fail meanwhile
  // Bumped to call off an armed retry: a later failure the server would repeat (a refused
  // field, say) means trying again unchanged can only send the refused value once more.
  let retryRound = 0;
  // The save row is a draft's; a scheduled post renders none.
  const saveBtn = locked ? null : $<HTMLButtonElement>("#saveBtn");
  const saveStatus = locked ? null : $("#saveStatus");
  const dirty = new DirtyTracker(collect);
  let saving = false;
  // The placeholders of images still on their way up; its size is how many are out.
  const uploading = new Set<string>();
  // Another writer's version, taken into the editor with nothing unsaved here (SPEC §4), said
  // on the save cue in place of Saved until the next edit, so the change on screen is
  // explained where the save state is read, not in a toast that fades (DESIGN §5).
  let tookIn: string | null = null;
  // The autosave editor's counterpart to the shared save bar's dot: same amber
  // "unsaved" cue (dot + text), extended to the autosave lifecycle it actually has —
  // Saving… while a save is in flight, Saved once it lands. Empty while locked
  // (a scheduled post can't be edited here).
  function renderSaveStatus() {
    if (!saveStatus) {
      return;
    }
    if (locked) {
      saveStatus.className = "save-status";
      saveStatus.textContent = "";
    } else if (saving) {
      saveStatus.className = "save-status is-saving";
      saveStatus.textContent = "Saving…";
    } else if (saveError && editorDirty) {
      saveStatus.className = "save-status is-error";
      saveStatus.textContent = `Not saved: ${saveError}`;
    } else if (editorDirty) {
      saveStatus.className = "save-status is-dirty";
      saveStatus.textContent = "Unsaved changes";
    } else {
      saveStatus.className = "save-status is-saved";
      saveStatus.textContent = tookIn ?? "Saved";
    }
  }
  function refreshDirty() {
    editorDirty = dirty.dirty;
    if (!editorDirty) {
      // Back to what was last saved (an undo, say): nothing is unsaved, so no failure stands.
      saveError = null;
      saveFailed = false;
      retryDelay = 0;
    }
    renderSaveStatus();
  }
  renderSaveStatus(); // paint the initial state (Saved on a fresh draft; empty if locked)
  function scheduleAutosave() {
    mine.touch();
  }
  // Called after any edit — typed, formatted, or an inserted image — through the body's input event.
  function markEdited() {
    if (locked) {
      return;
    }
    paintMarkdown(); // repaint the highlight overlay from the new textarea value
    tookIn = null; // the cue is about this edit now
    // A failure that won't be tried again (a refused field, say) is answered by this edit:
    // its reason would point at a mark the edit may have cleared. One whose retry is armed
    // keeps its line, since the retry still carries this edit.
    if (saveError && !retryArmed) {
      saveError = null;
    }
    refreshDirty();
    if (!conflicted) {
      scheduleAutosave();
    }
  }

  // Saves are chained so an autosave and an explicit save can never overlap; a
  // silent save with nothing pending is skipped.
  let saveChain: Promise<unknown> = Promise.resolve();
  function saveDraft(silent: boolean): Promise<SaveResult> {
    const next = saveChain.catch(() => {}).then(() => doSaveDraft(silent));
    saveChain = next;
    trackSaves(saveChain);
    return next;
  }
  async function doSaveDraft(silent: boolean): Promise<SaveResult> {
    if (silent && !dirty.dirty) {
      return "unchanged"; // nothing changed since the last save
    }
    if (conflicted) {
      return "refused"; // paused until the out-of-date banner is resolved
    }
    mine.cancel(); // a save is starting — cancel any pending autosave trigger
    saving = true;
    renderSaveStatus(); // reflect Saving… right away; the finally re-renders when done
    // What this save sends is what it saves: an edit typed while it is in flight stays
    // dirty and goes with the next one.
    const fields = collect();
    const sent = JSON.stringify(fields);
    let landed = false;
    let readAgain = false; // a stale refusal of a save that carried nothing new
    try {
      const body: PostEditBody = { ...fields, base_revision: revisions.base };
      const { post: u, subject_slug_held } = await api<PostSavedResponse>(`/api/posts/${id}`, {
        method: "PUT",
        json: body,
      });
      // The server derives a following slug from the subject on each save (SPEC §4).
      adopt(u, subject_slug_held);
      revisions.saved(u.current_revision); // our save is now the newest; poll against it
      dirty.markSaved(sent);
      saveFailed = false;
      saveError = null;
      retryDelay = 0;
      tookIn = null; // ours is the newest version now, so the note about theirs is done
      if (!silent) {
        toast("Saved");
      }
      landed = true;
      return "saved";
    } catch (e) {
      // A stale-revision 409 isn't a plain failure: another writer got there first.
      // Surface the out-of-date banner (notify, don't clobber) instead of an error toast.
      const conflict = conflictFromError(e);
      if (conflict?.kind === "stale" && !dirty.dirty && uploading.size === 0) {
        // Nothing here is unsaved (a Save draft with nothing new, say): read the newer
        // version and take it in, as the freshness poll would, once this save has let go.
        readAgain = true;
        return "refused";
      }
      if (conflict) {
        showConflict(conflict);
        return "refused";
      }
      if (isNotFound(e)) {
        removed();
        return "refused";
      }
      saveFailed = true; // the leave guard now prompts rather than silently flushing
      // A refusal naming the subject is said under that field, and the cue points there; the
      // server will refuse the same value again, so it is not retried.
      const named = e instanceof ApiError && e.field === "subject" ? subjectEl : undefined;
      if (named) {
        // Kept with the empty-subject error's clearer, so a version taken in clears either.
        clearSubjectErr = fieldError(named, describeError(e));
        saveError = "fix the field marked above.";
      } else {
        saveError = describeError(e);
      }
      // Only a failure that can pass on its own is tried again: no answer, the server's
      // own trouble, or too many requests at once. Anything else (a refusal, a bug in the
      // page) would fail the same way, so it calls off a retry an earlier failure armed.
      const transient =
        isNetworkFailure(e) || (e instanceof ApiError && (e.status >= 500 || e.status === 429));
      if (!transient) {
        retryRound += 1;
        retryArmed = false;
        retryDelay = 0; // a later dropped connection starts its spacing afresh
      } else if (!retryArmed) {
        retryArmed = true;
        retryDelay = retryDelay ? Math.min(retryDelay * 2, 60_000) : 5_000;
        const round = retryRound;
        at(
          Date.now() + retryDelay,
          () => {
            if (round !== retryRound) {
              return; // called off by a failure that would only repeat
            }
            retryArmed = false;
            if (saveError && !conflicted) {
              saveDraft(true).catch(() => {}); // a failure says so on the cue again
            }
          },
          signal,
        );
      }
      throw e;
    } finally {
      saving = false;
      refreshDirty();
      if (landed) {
        renderAhead(); // so Preview is ready when it's opened
      }
      if (readAgain) {
        readFreshness();
      }
    }
  }
  if (saveBtn) {
    saveBtn.onclick = () => {
      // While the out-of-date banner is up a save is paused (notify, never clobber: SPEC
      // §4), so the button reads as unavailable and a click (or ⌘S) does not pretend to
      // save: it points at the banner, whose Reload or Keep editing is the next step.
      // aria-disabled, not disabled, so the click still lands to do that.
      if (conflicted) {
        freshnessEl.scrollIntoView({ block: "nearest" });
        return;
      }
      busy(saveBtn, "Saving…", () => saveDraft(false).catch(() => {})).finally(refreshDirty);
    };
  }
  // Save draft follows the banner: unavailable while it asks for a decision, and says why.
  function paintSaveBtn() {
    if (!saveBtn) {
      return;
    }
    if (conflicted) {
      saveBtn.setAttribute("aria-disabled", "true");
      saveBtn.title = "Saving is paused: choose Reload or Keep editing above";
    } else {
      saveBtn.removeAttribute("aria-disabled");
      saveBtn.removeAttribute("title");
    }
  }

  // Leaving the editor saves in the background instead of prompting. Capture the
  // fields NOW (the mount tears down the DOM right after) and send them through
  // the chain so they can't overlap an in-flight save. Deliberately not bound to the
  // signal: a save the reader started must land whether or not they stayed to watch.
  // A save already in flight (a blur's, the Web version link's) may carry these very
  // edits, so the flush asks again once it lands, and reads the base then: a base taken
  // now would be older than that save, and the server would refuse our own edits as
  // another writer's.
  const leaveFlush = () => {
    mine.cancel();
    if (locked || !dirty.dirty) {
      return;
    }
    const fields = collect();
    const sent = JSON.stringify(fields);
    editorDirty = false;
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        if (!dirty.dirty) {
          return;
        }
        const body: PostEditBody = { ...fields, base_revision: revisions.base };
        const { post: u } = await api<PostSavedResponse>(`/api/posts/${id}`, {
          method: "PUT",
          json: body,
        });
        revisions.saved(u.current_revision);
        dirty.markSaved(sent);
      })
      .catch((e) => {
        if (isNotFound(e)) {
          // The reader has left, and their edits with the page: say what happened to them.
          toast("This post was deleted elsewhere, so your last edits weren’t saved.");
          return;
        }
        toast(
          e instanceof ApiError && e.status === 409
            ? "Changed elsewhere, so your edits weren’t saved"
            : `Couldn’t save your changes: ${message(e)}`,
        );
      });
    trackSaves(saveChain);
  };
  const handle: ViewHandle = {
    // An image still uploading is work the page would lose: its placeholder never becomes the image.
    dirty: () => editorDirty || uploading.size > 0,
    beforeLeave() {
      if (gone) {
        return "leave"; // on its way to Drafts: there is nothing left to save to
      }
      if (editorDirty && (saveFailed || conflicted)) {
        return "confirm"; // a silent flush would fail (or clobber): the reader decides
      }
      leaveFlush();
      // The text is saved either way; leaving mid-upload keeps the placeholder in it, so ask.
      return uploading.size > 0 ? "confirm" : "leave";
    },
    manualSave() {
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.click();
      }
    },
  };

  // Typed edits mark dirty; leaving the subject, or Enter in it, flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    for (const el of [subjectEl, ta]) {
      el.addEventListener("input", markEdited);
    }
    for (const el of [subjectEl]) {
      el.addEventListener(
        "blur",
        () => saveDraft(true).catch(() => {}) /* the save cue says why */,
      );
      // Enter commits a one-line field the way leaving it does, but not the Enter that ends
      // an IME composition, which Safari reports with isComposing false and keyCode 229.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          saveDraft(true).catch(() => {}); // the save cue says why
        }
      });
    }
  }

  // --- concurrent-edit detection (SPEC §4) ---
  // Another tab, Claude, or a script through the API can save this draft while it's open
  // here. A save carries base_revision so the server rejects a stale write (409), and a
  // light poll finds a newer revision before the writer invests more effort. With nothing
  // unsaved here the newer version is taken in place, so the editor follows the draft while
  // Claude works on it; with something unsaved the banner asks: Reload takes the other
  // version, Keep editing keeps yours (your next save overwrites it). Re-arm only on a
  // genuinely newer revision.
  const freshnessEl = $("#freshnessBanner");

  // An input method's composition is text not yet settled, which taking a version in would
  // break into: the read waits for the next one.
  let composing = false;
  if (!locked) {
    for (const el of [subjectEl, ta]) {
      el.addEventListener("compositionstart", () => {
        composing = true;
      });
      el.addEventListener("compositionend", () => {
        composing = false;
      });
    }
  }

  /** Put `text` in `el` in place of what it holds, keeping its caret, selection, and scroll
   *  where the same words are, without taking focus. */
  function replaceKeepingPlace(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
    const before = el.value;
    if (before === text) {
      return;
    }
    const focused = document.activeElement === el;
    const start = carryOffset(before, text, el.selectionStart ?? 0);
    const end = carryOffset(before, text, el.selectionEnd ?? 0);
    const top = el.scrollTop;
    el.value = text;
    if (focused) {
      el.setSelectionRange(start, end, el.selectionDirection ?? "none");
    }
    el.scrollTop = top;
  }

  /** Take another writer's newer version into an editor with nothing unsaved (SPEC §4): it
   *  becomes the text on screen and the base, and the save cue says whose it is. */
  function takeIn(fresh: PostResponse, revision: string) {
    // Setting a field's value fires no input event, so an error under the subject would stay
    // over their subject, which the publisher never typed.
    clearSubjectError();
    replaceKeepingPlace(subjectEl, fresh.post.subject);
    replaceKeepingPlace(ta, fresh.markdown);
    nameTab();
    paintMarkdown();
    imagesChanged?.();
    revisions.took(revision);
    dirty.markSaved();
    adopt(fresh.post, fresh.subject_slug_held);
    const who = whoActed(fresh.post.author, fresh.post.author_client);
    const at = fresh.post.updated_at; // when they saved, not when this editor noticed
    const when = fmtAt(at, clocksFor([at]));
    tookIn = `Updated with changes ${who ? `by ${who}` : "made elsewhere"} · ${when}`;
    refreshDirty();
    // The email on screen is the old version's. On the Preview tab, ask for the new one the
    // way opening the tab does, so a render that fails says so rather than staying on
    // Updating…; elsewhere, mark it and render ahead.
    if (tab === "preview") {
      showPreview();
    } else {
      paintPreview();
      renderAhead();
    }
  }

  function clearConflict() {
    conflicted = false;
    paintSaveBtn();
    revisions.clearWarning();
    freshnessEl.hidden = true;
    setHtml(freshnessEl, html``);
  }
  function showConflict(conflict: Conflict) {
    if (locked) {
      return;
    }
    conflicted = true; // pauses autosave; makes the leave guard prompt
    imagesChanged?.(); // the saved post is now another writer's
    saveError = null; // the banner is the story now; an older failure's reason would contradict it
    paintSaveBtn();
    revisions.noteWarned(conflict);
    if (conflict.kind === "locked") {
      setHtml(
        freshnessEl,
        html`<span><span aria-hidden="true">⚠️</span> This draft was scheduled elsewhere and can no longer be edited here.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button></span>`,
      );
    } else {
      const who = whoActed(conflict.author, conflict.client);
      setHtml(
        freshnessEl,
        html`<span><span aria-hidden="true">⚠️</span> This draft was changed elsewhere${who ? html`, last edited by <strong>${who}</strong>` : null}. Saving is paused until you choose: Reload to load that version (discards your unsaved edits), or Keep editing to keep yours, and your next save overwrites that version.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button><button type="button" class="ghost" id="freshKeep">Keep editing</button></span>`,
      );
    }
    freshnessEl.hidden = false;
    $<HTMLButtonElement>("#freshReload", freshnessEl).onclick = () => {
      clearConflict();
      remount();
    };
    const keep = freshnessEl.querySelector<HTMLButtonElement>("#freshKeep");
    if (keep) {
      keep.onclick = () => {
        revisions.adoptWarned(); // the newer revision becomes our base — our next save wins
        // The banner rose over unsaved edits, but an undo can bring the text back to our
        // last save before the click. The server holds theirs, so ours is still owed a save.
        if (!dirty.dirty) {
          dirty.markUnsaved();
        }
        clearConflict();
        refreshDirty();
        scheduleAutosave();
        // Preview showed the other writer's version, marked as not the email now: open on it,
        // it saves what is on screen and renders that.
        if (tab === "preview") {
          showPreview();
        } else {
          paintPreview();
        }
      };
    }
    // The email on screen is no longer the saved post's: mark it now, not on the next look.
    paintPreview();
  }

  // A read or write that found the post gone (a 404) answers it here, whichever control
  // made it: the API names only what it didn't find ("post"), which says nothing alone.
  function foundGone(e: unknown): boolean {
    if (!isNotFound(e)) {
      return false;
    }
    removed();
    return true;
  }

  // Skipped while hidden, saving, or showing the banner: the read is cheap, and it acts only
  // on a revision not yet taken in or warned of. Read at once when the tab is shown.
  async function pollFreshness() {
    if (locked || saving || conflicted || gone || document.hidden) {
      return;
    }
    const baseAtRequest = revisions.base; // to tell our own save landing mid-poll from another writer's
    try {
      const fresh = await api<PostResponse>(`/api/posts/${id}`, { signal });
      if (conflicted || gone) {
        return; // a save's refusal answered first
      }
      const decision = revisions.decide(
        {
          status: fresh.post.status,
          revision: fresh.post.current_revision,
          author: fresh.post.author,
          client: fresh.post.author_client,
        },
        { saving, baseAtRequest },
      );
      if (decision === "ignore") {
        return; // the read may predate our own save
      }
      // A settings change made elsewhere writes no revision, so every read carries it.
      adopt(fresh.post, fresh.subject_slug_held);
      if (decision === "fresh") {
        return;
      }
      if (decision.kind === "locked") {
        showConflict(decision);
        return;
      }
      // Read now, after the wait: a keystroke that landed while the read was out makes this a
      // choice for the publisher, and nothing runs between this check and the swap.
      const answer = answerNewer({ unsaved: dirty.dirty || uploading.size > 0, composing });
      if (answer === "take") {
        takeIn(fresh, decision.revision);
      } else if (answer === "banner") {
        showConflict(decision);
      }
    } catch (e) {
      if (isNotFound(e)) {
        removed();
      }
      // Anything else is transient: try again next tick.
    }
  }
  /** Read the post's freshness now, outside the poll's pace. */
  function readFreshness() {
    pollFreshness().catch(() => {});
  }
  if (!locked) {
    every(10000, pollFreshness, signal);
    readWhenShown(pollFreshness, signal);
  }

  // --- web version: the post as its public page will show it (SPEC §5) ---
  // A plain link, so no browser blocks it as a pop-up. The click saves pending edits and
  // lets the link go: a new tab loads the editor and signs in before it reads the page, so
  // the save is ahead of it; opened in place, the page waits for it (pending_save.ts). A
  // refused or failed save shows here as any save does.
  // Where the link opens in place (a browser pane with no tabs), it is a same-document hash
  // change, so nothing unloads to cut the save off, and the leave flush that follows sees
  // it in flight and doesn't send it twice.
  $<HTMLAnchorElement>("#webLink").addEventListener("click", () => {
    if (!locked) {
      saveDraft(true).catch(() => {}) /* the save cue says why */;
    }
  });

  if (locked && scheduled) {
    // The send as last reported: this page's read of it (or, until that succeeds, the post's
    // reference to it, which says its fire time and no condition), then each read of the
    // send-state layer that found it changed, whichever client changed it (DESIGN §4).
    let current: BannerSend = sendRead?.send ?? { ...scheduled, conditions: [] };
    const whenEl = $("#schedWhen");
    const controls = $("#schedControls");
    // --- the banner: the cards' countdown, and the review window closing at the fire time ---
    // Before the fire time it counts down on the clock. From then the server refuses Cancel
    // and Edit schedule (SPEC §6), so the same line reads "Preparing to send…" in place of the
    // countdown and the buttons stay where they are, disabled: the page hands off to the
    // live send within seconds, so nothing needs to move. Past the server's missed
    // tolerance it says how late the send is, from the server's condition.
    // The switch happens on this page's clock, at the fire time itself (a tick of its own
    // when the fire time is inside the coming second), with no read needed. Before it the
    // buttons are the server's to offer (`actions`); from it the clock only disables what
    // was offered, so a read that answered before the fire time cannot bring them back.
    let painted = "";
    let armed = 0; // the fire time an exact tick is set for, so it is set once
    let seenOpen = false; // whether this page showed the window open, and so its buttons
    const reschedBtn = $<HTMLButtonElement>("#rescheduleSchedule");
    const cancelBtn = $<HTMLButtonElement>("#cancelSchedule");
    const offers = (name: SendAction["name"]) =>
      current.actions === undefined || can({ actions: current.actions }, name);
    const paintBanner = () => {
      const now = Date.now();
      const due = current.phase === "due" || now >= current.fire_at;
      if (!due) {
        seenOpen = true;
        reschedBtn.hidden = !offers("reschedule");
        cancelBtn.hidden = !offers("cancel");
      } else if (!seenOpen) {
        // Opened after the window closed: there is nothing to show disabled.
        reschedBtn.hidden = true;
        cancelBtn.hidden = true;
      }
      reschedBtn.disabled = due;
      cancelBtn.disabled = due;
      controls.hidden = reschedBtn.hidden && cancelBtn.hidden;
      const markup = scheduledBannerHtml(current, due);
      const key = String(markup);
      if (key !== painted) {
        painted = key;
        setHtml(whenEl, markup);
      }
      if (!due && current.fire_at - now <= 1000 && current.fire_at !== armed) {
        armed = current.fire_at;
        at(current.fire_at, paintBanner, signal);
      }
    };
    paintBanner();
    every(1000, paintBanner, signal);

    // --- re-made since its last test (SPEC §8): the server's condition, in the banner ---
    // A template or identity change re-made the frozen email, so an earlier test no longer
    // shows what will go out. The server says so until a test of the re-made copy lands,
    // the same fact Claude reads. The banner only says so: Send test email is in the actions
    // bar below, and a second one here would crowd the banner's own controls. A send never
    // tested at all is said quietly instead (SPEC §8), as "Not tested yet" beside Send test
    // email, the control that settles it, until its first test lands.
    // On Workers Free's limits, a send too large for D1's daily writes says so here too, in
    // the server's words, for as long as it is scheduled (DESIGN §4). It never blocks. So does
    // one scheduled while SES is in the sandbox, which reaches only verified addresses, and one
    // scheduled while email is refusing, which will be held when it fires (SPEC §13): the
    // stronger note, so it keeps the held line's weight.
    const remadeEl = $("#schedRemade");
    const testHintEl = $("#testHint");
    const dailyWritesEl = $("#schedDailyWrites");
    const byEl = $("#schedBy");
    const paintConditions = () => {
      // Who last acted on it (SPEC §11), once the send's own read says, and only when someone
      // other than you in the editor did (DESIGN §4): the send that needs noticing.
      const by = bannerActedBy(current, you);
      byEl.hidden = by === null;
      byEl.textContent = by ?? "";
      const remade = conditionOf(current, "remade");
      remadeEl.hidden = !remade;
      $("#schedRemadeMsg").textContent = remade?.message ?? "";
      testHintEl.hidden = !conditionOf(current, "untested");
      const dailyWrites = conditionOf(current, "daily_writes");
      dailyWritesEl.hidden = !dailyWrites;
      $("#schedDailyWritesMsg").textContent = dailyWrites?.message ?? "";
      const sandbox = conditionOf(current, "sandbox");
      $("#schedSandbox").hidden = !sandbox;
      $("#schedSandboxMsg").textContent = sandbox?.message ?? "";
      const refusing = conditionOf(current, "refusing");
      $("#schedRefusing").hidden = !refusing;
      $("#schedRefusingMsg").textContent = refusing?.message ?? "";
    };
    paintConditions();

    // --- following the send (DESIGN §4) ---
    // A move, a re-make, or a cancel made elsewhere (by Claude or another tab) shows in
    // place, and when the send starts this page hands off to its send page, which is the
    // send's home from then on, saying why the page changed.
    const follow = (from: SendResponse) =>
      followSend(
        from,
        {
          update(send: SendView, change: StageChange | null) {
            // A change to the post's settings gives its send a new `rev` with no change of stage,
            // so such a report may carry a change made elsewhere (Claude, another tab): read the
            // post again for the banner's row. A stage change hands off below instead.
            const settingsMayHaveChanged = !change && send.rev !== current.rev;
            // A re-make (a template or identity change) rewrites the frozen copy under the same
            // revision, so the render held for it is no longer the email that will send.
            const copyMayHaveChanged =
              send.rev !== current.rev || send.remade_at !== (current.remade_at ?? null);
            current = send;
            if (settingsMayHaveChanged) {
              void rereadPublishing();
            }
            if (change?.to === "sending" || change?.to === "sent" || change?.to === "complete") {
              toast("Your send started, so this page switched to its live watch.");
              handOff(`#/sent/${send.id}`);
              return;
            }
            if (change?.to === "canceled") {
              toast("The schedule was canceled elsewhere, so this post is a draft again.");
              remount();
              return;
            }
            paintBanner();
            paintConditions();
            if (copyMayHaveChanged) {
              renders.forget();
              if (tab === "preview") {
                void showPreview();
              } else {
                paintPreview();
              }
            }
          },
          removed,
          // The layer's cursor ran ahead of the database: read the post and its send again.
          stale: remount,
        },
        signal,
      );
    if (sendRead) {
      follow(sendRead);
    } else {
      // The send's read failed: try it again, spaced out, and follow from the first that
      // answers. A failure throws, which the poll takes as "try again".
      poll(
        5000,
        async () => {
          const read = await api<SendResponse>(`/api/sends/${scheduled.id}`, { signal });
          if (!movedOn(read.send, remount)) {
            current = read.send;
            paintBanner();
            paintConditions();
            follow(read);
          }
          return false;
        },
        signal,
      );
    }

    // --- reschedule (from the scheduled banner): move the fire time, content stays frozen ---
    reschedBtn.onclick = () =>
      void openRescheduleModal(
        { id: current.id, post_id: id, fire_at: current.fire_at },
        remount,
        signal,
        { ...pub },
      );

    // --- cancel schedule (from the scheduled banner) ---
    cancelBtn.onclick = () =>
      busy(cancelBtn, "Canceling…", async () => {
        try {
          await api(`/api/sends/${scheduled.id}/cancel`, { method: "POST" });
          toast("Schedule canceled");
          remount();
        } catch (e) {
          if (isNotFound(e)) {
            removed(); // the send went with its post before the follow noticed
          } else if (e instanceof ApiError && e.code === "window_closed") {
            // The fire time passed while the cancel was out, so the email is going out. The
            // server's clock has closed the window even if this page's has not, so the banner
            // reads as due, and the follow, read at once, hands off to the live watch when
            // the send starts.
            current = { ...current, phase: "due" };
            toast("Too late to cancel: the send time has passed, so this email is going out.");
            readSendsNow();
          } else {
            toast(message(e));
          }
        }
        // `busy` hands the button back when it ends; a cancel still answering at the fire
        // time must not re-enable it, so the clock's verdict is painted again at once.
      }).finally(paintBanner);
  }

  // --- image upload: drag/drop, paste, click ---
  // A browser names a pasted image itself, so a name that disagrees with the image's type is no
  // claim the publisher made, and no name they could change. The server refuses one, so a paste
  // goes under a name that agrees.
  function pasteNamed(file: File): File {
    const named = imageTypeOfName(file.name);
    const extension = Object.keys(IMAGE_TYPE_BY_EXTENSION).find(
      (e) => IMAGE_TYPE_BY_EXTENSION[e] === file.type,
    );
    if (!named || named === file.type || !extension) {
      return file;
    }
    return new File([file], `image${extension}`, { type: file.type });
  }

  // An image goes in as a placeholder line the moment it arrives (posts/uploads.ts), and the
  // upload swaps it for the real reference. While any upload is out, the foot says so, and Send
  // test and Schedule wait, so a placeholder never reaches an email.
  const footDefault = "Paste, drop, or click to add images";
  // A file held over the body. The foot says what a drop does, since the body keeps showing
  // its text: the image goes in at the caret, which the publisher needs to see.
  let dragOver = false;
  function paintUploads() {
    const uploadsOut = uploading.size;
    const foot = root.querySelector("#dropFoot span");
    if (foot) {
      foot.textContent = dragOver
        ? "Drop images to upload"
        : uploadsOut
          ? `Uploading ${uploadsOut} image${uploadsOut === 1 ? "" : "s"}…`
          : footDefault;
    }
    for (const b of $$<HTMLButtonElement>("#testBtn, #scheduleBtn", root)) {
      b.disabled = uploadsOut > 0;
      if (uploadsOut) {
        b.title = "Waiting for an image to finish uploading";
      } else {
        b.removeAttribute("title");
      }
    }
  }
  // Each edit goes through replaceRange, so it is an undo step and its input event marks the
  // draft edited. An upload is two steps, the placeholder and its swap, and undoing the swap
  // brings back a placeholder nothing will replace; a second undo takes it out. Folding the two
  // into one would mean an undo when the upload answers, at a moment of the browser's choosing,
  // and the browser's undo history is the page's, not the body's: it could take back what the
  // publisher was just typing in the subject. A placeholder left this way is a comment, so it
  // shows readers nothing.
  function editText(edit: TextEdit) {
    replaceRange(ta, edit.from, edit.to, edit.text, edit.select);
  }
  function textState(): TextState {
    return { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  }
  function uploadAndInsert(file: File) {
    const refusal = uploadRefusal(file);
    if (refusal) {
      toast(refusal);
      return;
    }
    const placeholder = placeholderFor(file.name, ta.value, uploading);
    const placed = insertPlaceholder(textState(), placeholder);
    editText(placed.edit);
    uploading.add(placeholder);
    paintUploads();
    const fd = new FormData();
    fd.append("file", file);
    // A write, so not bound to the signal: the image is stored whether or not the publisher
    // stayed. Only the swap needs the page, and a left page keeps its placeholder as text.
    api<ImageUploadResponse>(`/api/posts/${id}/images`, { method: "POST", body: fd })
      .then(
        ({ image }) => {
          if (signal.aborted) {
            return;
          }
          // The render changes with the post's images, not only its revision: even with its
          // placeholder gone, the stored image is one the post now has.
          renders.forget();
          // The stored name on both sides: the name sent can hold a bracket that would end the alt text.
          const next = replacePlaceholder(
            textState(),
            placeholder,
            `![${image.filename}](${image.filename})`,
          );
          // An open Images dialog lists the new image, and reads its reference as used.
          imagesChanged?.();
          if (next) {
            editText(next);
            toast("Image added");
          } else {
            toast(
              `Uploaded “${image.filename}”, but its placeholder was removed, so it wasn’t added.`,
            );
          }
          // An upload is often the fix a warning asks for ("isn't on this post"): read the
          // render again so the line under the composer follows. With the text unsaved this
          // waits for the save's own render.
          renderAhead();
        },
        (e) => {
          if (signal.aborted) {
            return;
          }
          const next = replacePlaceholder(textState(), placeholder, "", placed.pad);
          if (next) {
            editText(next);
          }
          if (!foundGone(e)) {
            toast(message(e));
          }
        },
      )
      .finally(() => {
        uploading.delete(placeholder);
        if (!signal.aborted) {
          paintUploads();
        }
      });
  }
  // The Images dialog (./images_dialog.ts) lists the draft's images and hands back what to do
  // with the text. An image picked there goes where the caret was; a body never focused has
  // no caret the publisher chose, so it goes at the end rather than the start.
  let bodyFocused = false;
  ta.addEventListener("focus", () => {
    bodyFocused = true;
  });
  // One dialog at a time: the list is read before it opens, so a second press while that read
  // is out would otherwise open a second.
  let imagesOpening = false;
  function openImages() {
    if (imagesOpening) {
      return;
    }
    imagesOpening = true;
    void openImagesDialog(id, signal, {
      body: () => ta.value,
      watch: (changed) => {
        imagesChanged = changed;
      },
      insert: (filename) => {
        showTab("edit");
        const state = textState();
        const at = bodyFocused ? state : { ...state, start: ta.value.length, end: ta.value.length };
        const edit = insertImage(at, filename);
        editText(edit);
        // Neither layer scrolls on its own (#mdScroll is the scroller), and the browser keeps a
        // caret in view only while it's typed at, so an image put at the end of a long body
        // would land out of sight. Its line's row in the highlight stands in for the caret.
        const line = ta.value.slice(0, edit.select.start).split("\n").length - 1;
        mdHlCode.children[line]?.scrollIntoView({ block: "nearest" });
      },
      upload: (files) => {
        showTab("edit");
        for (const f of files) {
          uploadAndInsert(f);
        }
      },
      // The render changes with the post's images, not only its revision: read it again, so a
      // reference to the deleted image is warned of under the composer straight away.
      deleted: () => {
        renders.forget();
        renderAhead();
      },
      failed: (e) => {
        if (!foundGone(e)) {
          toast(message(e));
        }
      },
    }).finally(() => {
      imagesOpening = false;
    });
  }
  const composerBody = $("#composerBody");
  if (!locked) {
    const imgInput = $<HTMLInputElement>("#imgInput");
    const foot = $("#dropFoot");
    const showDragOver = (on: boolean) => {
      if (dragOver === on) {
        return;
      }
      dragOver = on;
      composerBody.classList.toggle("dragover", on);
      foot.classList.toggle("dragover", on);
      showDropCaret(composerBody, mdHlCode, ta, on);
      paintUploads();
    };
    composerBody.addEventListener("dragover", (e) => {
      e.preventDefault();
      showDragOver(true);
    });
    // Moving between the body's children fires this too, so only leaving the body clears it.
    // A drag that leaves the window, or is called off, leaves from whichever child it was
    // over and goes nowhere, which is why the test is where it went, not what it left.
    composerBody.addEventListener("dragleave", (e) => {
      if (!(e.relatedTarget instanceof Node && composerBody.contains(e.relatedTarget))) {
        showDragOver(false);
      }
    });
    composerBody.addEventListener("drop", (e) => {
      e.preventDefault();
      showDragOver(false);
      showTab("edit");
      for (const f of e.dataTransfer?.files ?? []) {
        uploadAndInsert(f);
      }
    });
    ta.addEventListener("paste", (e) => {
      for (const it of e.clipboardData?.items || []) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            uploadAndInsert(pasteNamed(f));
          }
        }
      }
    });
    foot.onclick = () => imgInput.click();
    imgInput.onchange = () => {
      for (const f of imgInput.files ?? []) {
        uploadAndInsert(f);
      }
      imgInput.value = "";
    };
  } else {
    // Locked: a key that would change the text, a paste, or a drop is refused (readonly
    // does the refusing; a drop is stopped from opening the file) and nudges the foot.
    // Navigation, selection, and copy keys pass, so reading stays free.
    const wouldEdit = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        return ["x", "z", "y"].includes(e.key.toLowerCase()); // cut, undo, redo (paste fires its own event)
      }
      return e.key.length === 1 || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete";
    };
    const fields: HTMLElement[] = [ta, subjectEl];
    for (const f of fields) {
      f.addEventListener("keydown", (e) => {
        if (wouldEdit(e)) {
          nudge();
        }
      });
      f.addEventListener("paste", nudge);
    }
    composerBody.addEventListener("dragover", (e) => e.preventDefault());
    composerBody.addEventListener("drop", (e) => {
      e.preventDefault();
      nudge();
    });
  }

  // --- send test (modal) ---
  // Pre-fills from the default test recipients (Settings) and accepts
  // several — one per line. Each address is a separate test send through the same
  // per-recipient path as a real send (I5).
  $<HTMLButtonElement>("#testBtn").onclick = () => {
    // A scheduled post's test is its frozen copy, exactly as it will fire (SPEC §5);
    // the dialog is where that is said (DESIGN §3).
    const lead = locked
      ? "Delivers the frozen copy that will send, exactly as it will fire, so you can check it in a client. One address per line."
      : "Delivers the rendered email to real inboxes so you can check it in a client. One address per line.";
    // While no provider is connected the server would refuse a test, so the dialog leaves
    // out the recipients and keeps only the standing line (DESIGN §4).
    const notConnected = providerNotConnected();
    const m = modal(
      html`<h3>Send a test</h3><p class="hint">${lead}</p>${notConnectedTestLine()}${notConnected ? null : html`<label for="testTo">Recipients</label><textarea id="testTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="testDefaultsHint" hidden></p>`}<div class="actions"><button type="button" id="tCancel">Cancel</button><button type="button" class="primary" id="tGo">Send test</button></div>`,
      signal,
    );
    const go = $<HTMLButtonElement>("#tGo", m.el);
    $("#tCancel", m.el).onclick = m.close;
    go.disabled = notConnected;
    if (notConnected) {
      $("#tCancel", m.el).focus();
      return;
    }
    const to = $<HTMLTextAreaElement>("#testTo", m.el);
    to.focus();
    // The hint names where the list came from, so it goes once the list is anyone else's.
    const defaultsHint = $("#testDefaultsHint", m.el);
    to.addEventListener("input", () => {
      defaultsHint.hidden = true;
    });
    // Pre-fill with saved defaults (don't clobber anything already typed).
    api<SettingsResponse>("/api/settings")
      .then((s) => {
        const defaults = s.settings.test_recipients || [];
        if (defaults.length && !to.value.trim()) {
          to.value = defaults.join("\n");
          m.clearError(); // an empty-field error raised before the defaults arrived no longer holds
          defaultsHint.textContent = "Pre-filled from your default test recipients (Settings).";
          defaultsHint.hidden = false;
        }
      })
      .catch(() => {});
    go.onclick = () =>
      busy(go, "Sending…", async () => {
        m.clearError();
        const { valid: addrs, invalid } = parseAddresses(to.value);
        const notAddresses = invalidAddressesMessage(invalid);
        if (notAddresses) {
          m.error(notAddresses, to);
          return;
        }
        if (!addrs.length) {
          m.error("Enter at least one email address", to);
          return;
        }
        try {
          // A refused save means the server holds another writer's newer revision, and a test
          // renders what is saved: it would deliver their version as the review of this text.
          // As with Schedule, close the dialog and let the out-of-date banner be the next step.
          if (!locked && (await saveDraft(true)) === "refused") {
            m.close();
            freshnessEl.scrollIntoView({ block: "nearest" });
            return;
          }
          // One request per address, each on its own, so one that fails doesn't stop the
          // rest, and the dialog can name exactly the ones to try again.
          let sent = 0;
          const missed: TestMiss[] = [];
          let lastWarnings: string[] | null = null;
          for (const addr of addrs) {
            try {
              const r = await api<TestSendResponse>(`/api/posts/${id}/test`, {
                method: "POST",
                json: { to: addr },
              });
              if (r.sent) {
                sent++;
              } else {
                missed.push({ email: addr, message: r.not_sent?.message ?? "" });
              }
              lastWarnings = r.warnings;
            } catch (e) {
              // A post that's gone, or a session that ended, ends the loop: every address
              // after it would fail the same way.
              if (isNotFound(e) || (e instanceof ApiError && e.status === 401)) {
                throw e;
              }
              missed.push({ email: addr, message: describeError(e) });
            }
          }
          // Only a test that rendered says what the render found: one where every address
          // failed leaves the line as it was rather than clearing a warning that still holds.
          if (lastWarnings) {
            showWarnings(lastWarnings);
          }
          // A test of a scheduled post settles its re-made condition on the server; read the
          // feed now so the banner's line goes with it rather than at the next idle read.
          if (locked && sent > 0) {
            readSendsNow();
          }
          if (missed.length) {
            // The dialog stays open with only the addresses that didn't get it, so Send again
            // tries those and no one gets a second copy.
            to.value = missed.map((x) => x.email).join("\n");
            defaultsHint.hidden = true;
            m.error(notSentMessage(sent, addrs.length, missed));
            return;
          }
          m.close();
          toast(withNoProviderNote(`Test sent to ${sent} address${sent === 1 ? "" : "es"}`));
        } catch (e) {
          if (isNotFound(e)) {
            m.close();
            foundGone(e);
            return;
          }
          m.error(message(e));
        }
      });
  };

  // --- schedule (the one send entry point; Send now lives inside as a demoted link) ---
  // Scheduling behind a cancelable review window is the literal default (SPEC §6);
  // sending immediately is the deliberate sub-choice. Both server flows are unchanged
  // (/schedule, /send) — this is one modal with two views, so the safer path is what
  // the Primary opens and the louder one is a step down.
  const scheduleBtn = locked ? null : $<HTMLButtonElement>("#scheduleBtn");
  if (scheduleBtn) {
    scheduleBtn.onclick = () => {
      if (!validateSubject()) {
        return; // empty subject: the field-level error is now showing; don't open the modal
      }
      // The picker reads and shows the publication's clock (SPEC §6), opening a day out.
      const def = Date.now() + 24 * 3600 * 1000;
      const c = clocksFor([def]);
      // While the server would refuse both views (no provider connected, or no time zone set),
      // the dialog drops the picker and the Send now row and leaves only the standing line
      // (DESIGN §4).
      const notConnected = !canSend();
      // The dialog's own copy of the post's settings (SPEC §4, §5): it opens as stored, the form
      // under the time edits it, and it reaches the post only when Schedule or Send now is
      // pressed, so Cancel leaves the post as it was. A following address shows the subject in
      // the field as it now stands, unless another post holds that slug.
      const opened = pub;
      const working: Publishing = { ...pub, subject: subjectEl.value };
      if (working.slugAuto && !working.slugTaken) {
        working.slug = slugify(working.subject) || working.slug;
      }
      const scheduleHint = "It sends at the time you pick, with a cancelable window until then.";
      const scheduleView = () =>
        html`<h3 id="schHead">Schedule this post</h3><p class="hint" id="schHint">${scheduleHint}</p>${notConnectedScheduleLine()}${noTimeZoneLine(!notConnected)}${dailyWritesLine()}${sandboxSendLine()}${refusingSendLine()}${notConnected ? null : html`${whenHtml("schWhen", def, c)}<div class="dialog-settings" id="schForm"></div>`}<div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>${notConnected ? null : html`<div class="altrow"><span class="altrow-note">Or send as soon as possible.</span><button type="button" class="linkbtn" id="toSendNow">Send now →</button></div>`}`;
      // The picked time survives a trip to Send now and back.
      let picked = toLocalInput(def, c.home);
      // The mounted picker, for the view that shows it; a trip to Send now and back mounts a
      // fresh one, its reads ending with the view.
      let picker: WhenPicker | null = null;
      let pickerMount: AbortController | null = null;
      const m = modal(scheduleView(), signal);
      const box = $(".modal", m.el);
      // Who a send would reach now: the confirmed addresses that aren't suppressed (SPEC §6),
      // read at most once, when a view first needs it. Neither view waits on it: their copy
      // reads sensibly until then.
      let audience: Promise<number | null> | null = null;
      const readAudience = () => {
        audience ??= api<SubscriberListResponse>(
          "/api/subscribers?status=confirmed&suppressed=hide&limit=1",
          { signal },
        )
          .then((s) => s.page.total)
          .catch(() => null);
        return audience;
      };
      // On Workers Free's limits, a send this large may spend D1's daily writes. The line
      // is the scheduled send's own `daily_writes` warning, in the same words, shown before
      // it is scheduled; it never disables a control (DESIGN §4).
      const paintDailyWrites = async () => {
        if (!box.querySelector("#schDailyWrites")) {
          return; // not on Free's limits, or no provider to send through
        }
        const n = await readAudience();
        const el = box.querySelector<HTMLElement>("#schDailyWrites"); // gone if closed or flipped
        if (el && n !== null && n > DAILY_WRITES_SEND_RECIPIENTS) {
          el.textContent = dailyWritesSendWarning(n);
          el.hidden = false;
        }
      };
      // In the SES sandbox a send reaches only verified addresses: the scheduled send's own
      // `sandbox` warning, in the same words, shown before it is scheduled (SPEC §6). And
      // while email is refusing, the send will be held when it fires: its own `refusing`
      // warning, in the same words, with the refusal's fix (SPEC §13). One read of the
      // provider serves both views and both lines.
      let provider: ReturnType<typeof readProviderStatus> | null = null;
      const paintProvider = async () => {
        provider ??= readProviderStatus(appState.appConfig?.deployment, signal);
        const status = await provider;
        const sandboxEl = box.querySelector<HTMLElement>("#schSandbox"); // gone if closed or flipped
        if (sandboxEl && inSandbox(status)) {
          sandboxEl.textContent = SANDBOX_SEND_WARNING;
          sandboxEl.hidden = false;
        }
        const refusal = refusalOf(status);
        const refusingEl = box.querySelector<HTMLElement>("#schRefusing");
        if (refusingEl && refusal) {
          refusingEl.textContent = refusingSendWarning(refusal);
          refusingEl.hidden = false;
        }
      };
      // A refused save closes the dialog, and the out-of-date banner it was covering is
      // the whole answer — so make sure the publisher is actually looking at it: they
      // clicked Schedule at the foot of the post and the banner sits at its head. Only
      // here, never in showConflict: the freshness poll raises the same banner on its own
      // every ten seconds, and scrolling the page out from under someone mid-sentence to
      // announce it would be its own bug. `nearest` leaves an already-visible banner alone.
      const refused = () => {
        m.close();
        freshnessEl.scrollIntoView({ block: "nearest" });
      };

      // The form under the time edits the dialog's copy; its first line follows the copy.
      const showForm = () => mountSettingsForm($("#schForm", box), working, "sch");
      // The dialog's settings go with the act itself, checked and applied together, so a
      // refused schedule changes neither and a refused address schedules nothing.
      // Only what the dialog changed is sent, so a change made elsewhere while it was open (the
      // post left out of the archive by Claude, say) is never undone by a box left as it opened.
      const settingsBody = () => settingsChange(opened, working) ?? {};
      /** A refusal of the address goes under its field; any other says itself as it would. */
      const sayRefusal = (e: unknown) => {
        if (!showSlugRefusal(box, "sch", e)) {
          m.error(message(e));
        }
      };

      const doSchedule = () =>
        busy($<HTMLButtonElement>("#schGo", box), "Scheduling…", async () => {
          m.clearError();
          const whenEl = $<HTMLInputElement>("#schWhen", box);
          const v = picker?.value() ?? "";
          if (!v) {
            m.error("Pick a valid date & time", whenEl);
            return;
          }
          const t = picker?.moment() ?? null;
          if (t !== null && isTooSoon(t)) {
            m.error(tooSoonText(), whenEl);
            return;
          }
          try {
            // A refused save means the server holds another writer's newer revision, so
            // scheduling now would freeze content the publisher never saw (SPEC §6).
            // Close the dialog and let the out-of-date banner behind it be the next step.
            if ((await saveDraft(true)) === "refused") {
              refused();
              return;
            }
            // The local time as picked: the server reads it on the publication's clock.
            const { send } = await api<ScheduleResponse>(`/api/posts/${id}/schedule`, {
              method: "POST",
              json: { fire_at: v, ...settingsBody() },
            });
            m.close();
            // Stay on the post, re-rendered in its scheduled state: the window is the
            // review and this page is the review surface (SPEC §6, DESIGN §3).
            const said = scheduledText(send.fire_at, clocksFor([send.fire_at]));
            toast(withNoProviderNote(`Scheduled for ${said}. Send yourself a test.`));
            remount();
          } catch (e) {
            if (isNotFound(e)) {
              m.close();
              foundGone(e);
              return;
            }
            // The server's clock is the authority on the lead; its refusal, in the same
            // words as the editor's own check, goes under the picker.
            if (e instanceof ApiError && e.field === "fire_at") {
              m.error(message(e), $<HTMLInputElement>("#schWhen", box));
              return;
            }
            sayRefusal(e);
          }
        });

      const doSendNow = () =>
        busy($<HTMLButtonElement>("#snGo", box), "Queuing…", async () => {
          m.clearError();
          try {
            // As in doSchedule: a refused save must not become a frozen send.
            if ((await saveDraft(true)) === "refused") {
              refused();
              return;
            }
            // The toast names the time the server answered, not the lead: the fire time is
            // rounded up to the minute (SPEC §6), so it can be up to a minute past the lead.
            const { send } = await api<ScheduleResponse>(`/api/posts/${id}/send`, {
              method: "POST",
              json: settingsBody(),
            });
            m.close();
            const said = scheduledText(send.fire_at, clocksFor([send.fire_at]));
            toast(withNoProviderNote(`Sends at ${said}, cancelable until then.`));
            remount();
          } catch (e) {
            if (isNotFound(e)) {
              m.close();
              foundGone(e);
              return;
            }
            sayRefusal(e);
          }
        });

      function wireSchedule() {
        box.setAttribute("aria-labelledby", "schHead");
        $("#schCancel", box).onclick = m.close;
        $("#schGo", box).onclick = doSchedule;
        // The server would refuse a schedule; the standing line above says why and where to
        // fix it, and the picker and Send now row are left out of the view.
        $<HTMLButtonElement>("#schGo", box).disabled = notConnected;
        if (notConnected) {
          $("#schCancel", box).focus();
          return;
        }
        $("#toSendNow", box).onclick = showSendNow;
        $<HTMLInputElement>("#schWhen", box).value = picked;
        pickerMount?.abort();
        pickerMount = new AbortController();
        signal.addEventListener("abort", () => pickerMount?.abort(), { once: true });
        picker = mountWhen(box, "schWhen", c, pickerMount.signal);
        showForm();
        $("#schWhen", box).focus();
        void paintDailyWrites();
        void paintProvider();
      }

      async function showSendNow() {
        const when = box.querySelector<HTMLInputElement>("#schWhen");
        if (when) {
          picked = when.value;
        }
        pickerMount?.abort();
        picker = null;
        setHtml(
          box,
          html`<h3 id="snHead">Send now?</h3><p class="hint">Sends this draft, as it is now, to <strong id="snWho">your subscribers</strong> in ${sendNowWhenText()}. The post locks until then, and you can cancel any time before it starts sending.</p><div class="dialog-settings" id="schForm"></div>${dailyWritesLine()}${sandboxSendLine()}${refusingSendLine()}<div class="actions"><button type="button" class="linkbtn actions-back" id="toSchedule">← Back to schedule</button><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`,
        );
        box.setAttribute("aria-labelledby", "snHead");
        $("#snCancel", box).onclick = m.close;
        $("#snGo", box).onclick = doSendNow;
        showForm();
        $<HTMLButtonElement>("#snGo", box).disabled = !postAction({ actions }, "send_now");
        $("#toSchedule", box).onclick = () => {
          setHtml(box, scheduleView());
          wireSchedule();
        };
        $("#snGo", box).focus();
        void paintDailyWrites();
        void paintProvider();
        // Fill the count once known. The confirmed count would still include the suppressed.
        const n = await readAudience();
        const whoEl = box.querySelector("#snWho"); // gone if the view flipped back meanwhile
        if (whoEl && n !== null) {
          whoEl.textContent = `${n} recipient${n === 1 ? "" : "s"}`;
        }
      }

      wireSchedule();
    };
  }
  return handle;
}

/** What the scheduled banner reads of its send. `phase`, `actions`, and who acted on it are
 *  absent only until the send's own read answers (the post's reference to it carries none). */
type BannerSend = Pick<SendView, "id" | "fire_at" | "rev" | "conditions"> &
  Partial<
    Pick<
      SendView,
      | "phase"
      | "actions"
      | "remade_at"
      | "scheduled_by"
      | "rescheduled_by"
      | "canceled_by"
      | "resolved_by"
    >
  >;

/**
 * Whether the send has moved on from scheduled, found on the editor's own read of it: once
 * it has started its send page is its home, and once canceled its post is a draft again,
 * which a fresh read of the post shows.
 */
function movedOn(send: SendView, remount: () => void): boolean {
  if (send.status === "sending" || send.status === "sent") {
    handOff(`#/sent/${send.id}`);
    return true;
  }
  if (send.status === "canceled") {
    remount();
    return true;
  }
  return false;
}

/**
 * The scheduled banner's words for where its send stands (DESIGN §4), in the cards' own
 * formats: the fire time and a countdown while the window is open; from the fire time, the
 * same line with "Preparing to send…" in place of the countdown; past the server's missed
 * tolerance, how late it is, in the danger tone.
 */
function scheduledBannerHtml(send: BannerSend, due: boolean): Html {
  const c = clocksFor([send.fire_at]);
  const zone = c.home;
  const at = html`Scheduled for <strong>${fmtAt(send.fire_at, c, true)}</strong>`;
  const second = secondClock(send.fire_at, c);
  const under = second ? html`<span class="second-clock">${second}</span>` : null;
  if (has(send, "missed")) {
    return html`${at} · <span class="countdown countdown-missed">${lateStr(send.fire_at)}</span>${under}`;
  }
  return html`${at} · <span class="countdown">${untilStr(send.fire_at, zone, due)}</span>${under}`;
}

/** Whether a read or write found its post (or its send, which goes with it) gone. */
function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

/** Where a post's send now lives, when that is no longer the editor: the watch while it
 *  sends, the record once it has sent. */
function sendHome(data: PostResponse): string | null {
  const send = data.post.send;
  if (send?.status === "sending") {
    return `#/sent/${send.id}`;
  }
  if (data.post.status === "sent") {
    return send ? `#/sent/${send.id}` : "#/sent";
  }
  return null;
}

/**
 * Move to a send's new home in place of this page's history entry (DESIGN §4): the
 * editor URL the reader opened has become the send page, so Back goes where they came
 * from rather than to an editor that would only hand them forward again.
 */
function handOff(hash: string): void {
  location.replace(hash);
}

// A tab hidden while a poll ticks skips those ticks; shown again, it reads at once rather
// than at the next tick, since anything may have happened meanwhile.
function readWhenShown(read: () => unknown, signal: AbortSignal): void {
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) {
        read();
      }
    },
    { signal },
  );
}
