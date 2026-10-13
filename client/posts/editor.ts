// The post editor: subject/slug, the Markdown composer, autosave with its idle and
// hard-cap timers, the freshness poll, images, the schedule / send-now dialogs, and a
// scheduled post's banner, which follows its send until the send page takes over.

import type { ImageUploadResponse } from "../../shared/images";
import type {
  PostEditBody,
  PostResponse,
  PostSavedResponse,
  TestSendResponse,
} from "../../shared/posts";
import type { ScheduleResponse, SendAction, SendResponse, SendView } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import type { SubscriberListResponse } from "../../shared/subscribers";
import { ApiError, api, apiText, describeError } from "../api";
import {
  connectProviderLink,
  earliestFireAt,
  heldWhenFiresHtml,
  minLeadText,
  notConnectedScheduleLine,
  notConnectedTestLine,
  notConnectedWarning,
  postArchiveUrl,
  providerNotConnected,
  withNoProviderNote,
} from "../deployment";
import { at, every, mount, onAbort, poll, type ViewHandle } from "../lifecycle";
import { followSend, readSendsNow, type StageChange } from "../send_state";
import { openRescheduleModal } from "../sends/dialogs";
import { can, conditionOf, has } from "../sends/progress";
import { $, $$ } from "../ui/dom";
import { EMAIL_FRAME_SANDBOX, openLinksInNewTab } from "../ui/email_frame";
import {
  fmt,
  invalidAddressesMessage,
  lateStr,
  parseAddresses,
  toLocalInput,
  untilStr,
} from "../ui/format";
import { highlightMarkdown } from "../ui/highlight";
import { type Html, html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { busy, fieldError, infoTip, modal, renderError, toast } from "../ui/widgets";
import { createAutosave } from "./autosave";
import { DirtyTracker } from "./dirty";
import { trackSaves } from "./pending_save";
import { type Author, type Conflict, conflictFromError, RevisionTracker } from "./revisions";
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
  ],
  [
    ["ul", "Bulleted list"],
    ["ol", "Numbered list"],
    ["indent", "Indent"],
  ],
];

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
const READONLY = html` readonly`;
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
  if (data.scheduled) {
    try {
      sendRead = await api<SendResponse>(`/api/sends/${data.scheduled.id}`, { signal });
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
  const { post, markdown, scheduled } = data;

  // The editor now only ever mounts a draft or a scheduled (frozen) post, so `locked`
  // means scheduled — signaled by the scheduled banner, not a status pill.
  const locked = post.status !== "draft";
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
        <a class="ghost btn" id="webLink" href="${webVersionUrl}" target="_blank" rel="noopener" aria-label="Web version (opens in a new tab)">Web version ↗</a>
      </div>
    </div>
    ${locked && scheduled ? html`<div class="banner banner-scheduled"><div class="sched-main"><span id="schedWhen"></span>${heldWhenFiresHtml()}<div class="sched-remade" id="schedRemade" hidden><span id="schedRemadeMsg"></span></div></div><span class="row" id="schedControls"><button type="button" class="ghost" id="rescheduleSchedule">Reschedule</button><button type="button" class="ghost" id="cancelSchedule">Cancel</button></span></div>` : null}
    <div id="freshnessBanner" class="banner banner-conflict" role="alert" hidden></div>
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${post.subject}" placeholder="Untitled"${ro}></div>
        <div>
          <div class="label-row">
            <label for="f-slug">Slug</label>
            ${infoTip("The web address of this post’s archive page.")}
          </div>
          <input id="f-slug" value="${post.slug}"${ro}>
          ${locked ? null : html`<label class="slug-auto-toggle"><input type="checkbox" id="f-slug-auto">Auto-generate from subject</label>`}
        </div>
      </div>

      <label for="f-markdown">Body</label>
      <div class="composer">
        <div class="composer-head">
          <div class="ctabs" role="tablist">
            <button type="button" class="ctab active" data-tab="edit" data-text="Edit" role="tab" aria-selected="true"><span class="ctab-label">${icon("editable")}Edit</span></button>
            <button type="button" class="ctab" data-tab="preview" data-text="Preview" role="tab" aria-selected="false"><span class="ctab-label">${icon("preview")}Preview</span></button>
          </div>
          <div class="toolbar" role="toolbar" aria-label="Formatting">${toolbarHtml}</div>
        </div>
        <div class="composer-body${locked ? " locked" : ""}" id="composerBody">
          <pre class="md-hl" id="mdHl" aria-hidden="true"><code></code></pre>
          <textarea id="f-markdown" class="editor"${locked ? null : html` placeholder="Type your post in Markdown…"`}${ro}>${markdown}</textarea>
          <iframe id="previewFrame" class="preview" sandbox="${EMAIL_FRAME_SANDBOX}" title="Email preview" hidden></iframe>
        </div>
        ${
          locked
            ? html`<div class="composer-foot composer-foot-lock" id="lockFoot" role="status">${icon("readonly")}<span>Cancel the schedule to edit</span></div>`
            : html`<div class="composer-foot" id="dropFoot">${icon("paperclip")}<span>Paste, drop, or click to add images</span></div>`
        }
        <input type="file" id="imgInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
      </div>
      <div id="warnings"></div>
      ${locked ? null : notConnectedWarning("editor-not-connected", html`No email provider connected: you can write and preview, not send. ${connectProviderLink()}.`)}

      <div class="actions-bar">
        ${
          locked
            ? html`<div class="row"><button type="button" class="secondary" id="testBtn">${icon("send")}<span>Send test email</span></button></div>`
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
  const slugEl = $<HTMLInputElement>("#f-slug");
  const ta = $<HTMLTextAreaElement>("#f-markdown");
  const toolbarEl = $(".toolbar", root);
  const previewFrame = $<HTMLIFrameElement>("#previewFrame");

  // Syntax-highlight overlay: a transparent <textarea> over a highlighted
  // <pre>, kept in scroll sync — the template editor's scaffolding, tokenizing Markdown.
  // Prose soft-wraps, so both layers share pre-wrap and identical metrics (the caret lands
  // on the colored text); that wrapping is also why there's no line-number gutter — a
  // number can't track a wrapped line and prose doesn't want one. The highlight is the point.
  const mdHl = $("#mdHl");
  const mdHlCode = $("code", mdHl);
  const syncMdScroll = () => {
    mdHl.scrollTop = ta.scrollTop;
    mdHl.scrollLeft = ta.scrollLeft;
  };
  const paintMarkdown = () => {
    // highlightMarkdown emits one block row per source line (split on "\n"), so the row count —
    // and thus the overlay height — already tracks the textarea, including a trailing blank line.
    setHtml(mdHlCode, highlightMarkdown(ta.value));
    syncMdScroll();
  };
  ta.addEventListener("scroll", syncMdScroll);
  paintMarkdown(); // paint the initial content (a scheduled post is read-only but still highlighted)

  // Whether the slug follows the subject is the post's own (`slug_auto`), never guessed from
  // its shape: `spring-update-2027` set by hand looks just like a numbered `spring-update`.
  // While it follows, a save sends no slug of its own and the server derives and numbers it;
  // once set by hand, the field is what is sent. Either way the field shows only slugs the server
  // answered with, never the editor's own guess, so it can lag a subject edit until the save
  // but never shows an address the post won't get.
  const autoEl = locked ? null : $<HTMLInputElement>("#f-slug-auto");
  const collect = () => ({
    subject: subjectEl.value,
    ...(autoEl?.checked ? { slug_auto: true } : { slug: slugEl.value, slug_auto: false }),
    markdown: ta.value,
  });
  // A save's answer for a slug being typed by hand waits until the field is left (or Enter),
  // so the cursor is never moved under the publisher; it lands only if the field still
  // holds what that save sent.
  let held: { shown: string; slug: string } | null = null;
  const applyHeld = () => {
    if (held && slugEl.value === held.shown) {
      slugEl.value = held.slug;
      refreshDirty(); // the field now matches what was saved
    }
    held = null;
  };

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

  // The "Auto-generate from subject" box, checked while the slug follows the subject. The
  // slug stays editable throughout. Typing your own slug takes manual control (unchecks);
  // emptying the field, or ticking the box, hands it back to the subject. The slug the
  // subject gives arrives with the save that leaving the subject makes (or Enter, or the
  // autosave).
  if (autoEl) {
    autoEl.checked = post.slug_auto;

    // Muted while it tracks the subject; normal color once it's set by hand.
    const reflect = () => slugEl.classList.toggle("slug-auto", autoEl.checked);
    reflect();

    // Typing a slug takes manual control; clearing it follows the subject again.
    slugEl.addEventListener("input", () => {
      autoEl.checked = slugEl.value.trim() === "";
      reflect();
    });
    // Ticking the box saves at once, so the field shows the subject's slug as soon as the
    // server answers; unticking hands over the field ready to edit.
    autoEl.addEventListener("change", () => {
      reflect();
      markEdited(); // the checkbox changes what a save sends without an input event
      if (autoEl.checked) {
        saveDraft(true).catch(() => {}) /* the save cue says why */;
      } else {
        slugEl.focus();
        slugEl.select();
      }
    });
    // Never leave an empty slug: a field left empty follows the subject again. The save
    // that leaving it makes fills it in; with nothing to save, the post already has the
    // subject's slug, so the field shows that.
    slugEl.addEventListener("blur", () => {
      applyHeld();
      if (slugEl.value.trim() === "") {
        autoEl.checked = true;
        reflect();
        markEdited();
        if (!dirty.dirty) {
          slugEl.value = savedSlug;
        }
      }
    });

    // Clear the empty-subject error as soon as a real subject is typed; it re-fires
    // on the next Schedule click if the field is still empty (see validateSubject).
    subjectEl.addEventListener("input", () => {
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
  function showTab(name: ComposerTab) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
    ta.hidden = name !== "edit";
    mdHl.hidden = name !== "edit"; // the highlight layer travels with the textarea
    previewFrame.hidden = name !== "preview";
    toolbarEl.classList.toggle("off", name !== "edit");
    // The image foot dims with the toolbar: a click on Preview would insert into a hidden
    // textarea behind a preview that doesn't change. A drop still lands (it switches to Edit).
    root.querySelector("#dropFoot")?.classList.toggle("off", name !== "edit");
    if (name === "edit") {
      syncMdScroll();
    }
  }
  // The slug the server last saved, which the preview renders with (a dedupe may differ
  // from what the field shows while it is being typed in).
  let savedSlug = post.slug;
  async function showPreview() {
    showTab("preview");
    try {
      if (!locked) {
        await saveDraft(true);
      }
      previewFrame.srcdoc = await apiText(`/api/posts/${id}/preview`);
      previewFrame.onload = () => {
        try {
          const doc = previewFrame.contentDocument;
          if (doc) {
            openLinksInNewTab(doc);
            // Read on each load, so a slug edited since the last preview is the one
            // matched. The editor holds only an unpublished post: once its send starts, the
            // editor hands off to the send page (and a web version opened after that goes
            // on to the public page itself).
            previewOpensWebVersion(doc, postArchiveUrl(savedSlug), webVersionUrl);
            previewFrame.style.height = `${doc.body.scrollHeight + 24}px`;
          }
        } catch {}
      };
    } catch (e) {
      if (signal.aborted || foundGone(e)) {
        return;
      }
      toast(message(e));
    }
  }
  for (const t of tabs) {
    t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("edit"));
  }
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
  function wrapSel(before: string, after: string, placeholder: string) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder;
    ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(prefix: string) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const start = ta.value.lastIndexOf("\n", s - 1) + 1;
    const out = (ta.value.slice(start, e) || "")
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = start + out.length;
  }
  function applyFormat(kind: string) {
    if (locked) {
      nudge(); // reached by a toolbar click or a Cmd+B / I / K shortcut
      return;
    }
    showTab("edit");
    if (kind === "bold") {
      wrapSel("**", "**", "bold text");
    } else if (kind === "italic") {
      wrapSel("*", "*", "italic text");
    } else if (kind === "heading") {
      prefixLines("## ");
    } else if (kind === "quote") {
      prefixLines("> ");
    } else if (kind === "ul") {
      prefixLines("- ");
    } else if (kind === "ol") {
      prefixLines("1. ");
    } else if (kind === "indent") {
      prefixLines("  ");
    } else if (kind === "link") {
      wrapSel("[", "](https://)", "link text");
    } else if (kind === "code") {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      if (s === e || ta.value.slice(s, e).includes("\n")) {
        wrapSel("```\n", "\n```", "code");
      } else {
        wrapSel("`", "`", "code");
      }
    }
    markEdited();
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
  let conflicted = false;
  // Why the last save failed, in the publisher's words, kept on the save cue until a save
  // succeeds: a toast would be gone in seconds and leave the cue reading like ordinary
  // typing. A failed save tries again on its own, spaced out, so a dropped connection
  // recovers without another edit.
  let saveError: string | null = null;
  let retryDelay = 0;
  let retryArmed = false; // one pending retry at a time, however many saves fail meanwhile
  // The save row is a draft's; a scheduled post renders none.
  const saveBtn = locked ? null : $<HTMLButtonElement>("#saveBtn");
  const saveStatus = locked ? null : $("#saveStatus");
  const dirty = new DirtyTracker(collect);
  let saving = false;
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
      saveStatus.textContent = "Saved";
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
  // Called after any edit — typed, formatted, or an inserted image.
  function markEdited() {
    if (locked) {
      return;
    }
    paintMarkdown(); // repaint the highlight overlay from the new textarea value
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
    let sent = JSON.stringify(fields);
    const slugShown = slugEl.value;
    try {
      const body: PostEditBody = { ...fields, base_revision: revisions.base };
      const { post: u } = await api<PostSavedResponse>(`/api/posts/${id}`, {
        method: "PUT",
        json: body,
      });
      // Show the slug the server gave (derived, numbered if taken), unless the field changed
      // while the save was out: that edit is unsaved, and the next save brings its own answer.
      // Focus alone is no reason to drop it, since tabbing through the field changes nothing;
      // a slug being typed by hand only has it wait until the field is left.
      if (u.slug && slugEl.value === slugShown) {
        // A slug set by hand is sent as typed; a following one is the server's to derive.
        const handSet = "slug" in fields;
        if (handSet && document.activeElement === slugEl) {
          held = { shown: slugShown, slug: u.slug }; // being typed by hand: see applyHeld
        } else {
          slugEl.value = u.slug;
        }
        if (handSet) {
          sent = JSON.stringify({ ...fields, slug: u.slug }); // what was saved, not what was typed
        }
      }
      if (u.slug) {
        savedSlug = u.slug;
      }
      revisions.saved(u.current_revision); // our save is now the newest; poll against it
      dirty.markSaved(sent);
      saveFailed = false;
      saveError = null;
      retryDelay = 0;
      if (!silent) {
        toast("Saved");
      }
      return "saved";
    } catch (e) {
      // A stale-revision 409 isn't a plain failure: another writer got there first.
      // Surface the out-of-date banner (notify, don't clobber) instead of an error toast.
      const conflict = conflictFromError(e);
      if (conflict) {
        showConflict(conflict);
        return "refused";
      }
      if (isNotFound(e)) {
        removed();
        return "refused";
      }
      saveFailed = true; // the leave guard now prompts rather than silently flushing
      saveError = describeError(e);
      if (!retryArmed) {
        retryArmed = true;
        retryDelay = retryDelay ? Math.min(retryDelay * 2, 60_000) : 5_000;
        at(
          Date.now() + retryDelay,
          () => {
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
    dirty: () => editorDirty,
    beforeLeave() {
      if (gone) {
        return "leave"; // on its way to Drafts: there is nothing left to save to
      }
      if (editorDirty && (saveFailed || conflicted)) {
        return "confirm"; // a silent flush would fail (or clobber): the reader decides
      }
      leaveFlush();
      return "leave";
    },
    manualSave() {
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.click();
      }
    },
  };

  // Typed edits mark dirty; leaving subject/slug, or Enter in one, flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    for (const el of [subjectEl, slugEl, ta]) {
      el.addEventListener("input", markEdited);
    }
    for (const el of [subjectEl, slugEl]) {
      el.addEventListener(
        "blur",
        () => saveDraft(true).catch(() => {}) /* the save cue says why */,
      );
      // Enter commits a one-line field the way leaving it does, but not the Enter that ends
      // an IME composition, which Safari reports with isComposing false and keyCode 229.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          saveDraft(true)
            .then(applyHeld) // Enter commits the slug, so show what it saved as
            .catch(() => {}); // the save cue says why
        }
      });
    }
  }

  // --- concurrent-edit detection (SPEC §4) ---
  // Another tab, or Claude through the API, can save this draft while it's open
  // here. A save carries base_revision so the server rejects a stale write (409);
  // a light poll warns before the writer invests more effort. We notify, never
  // adopt: Reload takes the other version, Keep editing keeps yours (your next
  // save overwrites it). Re-arm only on a genuinely newer revision.
  const freshnessEl = $("#freshnessBanner");
  const friendlyAuthor = (a: Author) => (a === "service" ? "Claude" : a || null);

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
    saveError = null; // the banner is the story now; an older failure's reason would contradict it
    paintSaveBtn();
    revisions.noteWarned(conflict);
    if (conflict.kind === "locked") {
      setHtml(
        freshnessEl,
        html`<span><span aria-hidden="true">⚠️</span> This draft was scheduled elsewhere and can no longer be edited here.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button></span>`,
      );
    } else {
      const who = friendlyAuthor(conflict.author);
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
        clearConflict();
        refreshDirty();
        if (editorDirty) {
          scheduleAutosave();
        }
      };
    }
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

  if (!locked) {
    // Skipped while hidden, saving, or already warned — poll GET is cheap and only
    // re-warns on a revision we haven't surfaced yet. Read at once when the tab is shown.
    const pollFreshness = async () => {
      if (saving || conflicted || gone || document.hidden) {
        return;
      }
      const baseAtRequest = revisions.base; // to tell our own save landing mid-poll from another writer's
      try {
        const fresh = await api<PostResponse>(`/api/posts/${id}`, { signal });
        const decision = revisions.decide(
          {
            status: fresh.post.status,
            revision: fresh.post.current_revision,
            author: fresh.author,
          },
          { saving, baseAtRequest },
        );
        if (decision !== "ignore" && decision !== "fresh") {
          showConflict(decision);
        }
      } catch (e) {
        if (isNotFound(e)) {
          removed();
        }
        // Anything else is transient: try again next tick.
      }
    };
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
    // The send as last reported: this page's read of it (or, until that succeeds, what the
    // post's read says of it), then each read of the send-state layer that found it
    // changed, whichever client changed it (DESIGN §4).
    let current: BannerSend = sendRead?.send ?? {
      ...scheduled,
      phase: "scheduled",
      conditions: [],
    };
    const whenEl = $("#schedWhen");
    const controls = $("#schedControls");
    // --- the banner: the cards' countdown, and the review window closing at the fire time ---
    // Before the fire time it counts down on the clock. From then the server refuses Cancel
    // and Reschedule (SPEC §6), so the same line reads "Preparing to send…" in place of the
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
    // bar below, and a second one here would crowd the banner's own controls.
    const remadeEl = $("#schedRemade");
    const paintRemade = () => {
      const remade = conditionOf(current, "remade");
      remadeEl.hidden = !remade;
      $("#schedRemadeMsg").textContent = remade?.message ?? "";
    };
    paintRemade();

    // --- following the send (DESIGN §4) ---
    // A move, a re-make, or a cancel made elsewhere (by Claude or another tab) shows in
    // place, and when the send starts this page hands off to its send page, which is the
    // send's home from then on, saying why the page changed.
    const follow = (from: SendResponse) =>
      followSend(
        from,
        {
          update(send: SendView, change: StageChange | null) {
            current = send;
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
            paintRemade();
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
            paintRemade();
            follow(read);
          }
          return false;
        },
        signal,
      );
    }

    // --- reschedule (from the scheduled banner): move the fire time, content stays frozen ---
    reschedBtn.onclick = () => openRescheduleModal(current.id, current.fire_at, remount, signal);

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
  async function uploadAndInsert(file: File) {
    if (!file.type.startsWith("image/")) {
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { image } = await api<ImageUploadResponse>(`/api/posts/${id}/images`, {
        method: "POST",
        body: fd,
      });
      const s = ta.selectionStart;
      const snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s + snippet.length;
      markEdited();
      toast("Image added");
    } catch (e) {
      if (!foundGone(e)) {
        toast(message(e));
      }
    }
  }
  const composerBody = $("#composerBody");
  if (!locked) {
    const imgInput = $<HTMLInputElement>("#imgInput");
    const foot = $("#dropFoot");
    composerBody.addEventListener("dragover", (e) => {
      e.preventDefault();
      composerBody.classList.add("dragover");
    });
    composerBody.addEventListener("dragleave", (e) => {
      if (e.target === composerBody) {
        composerBody.classList.remove("dragover");
      }
    });
    composerBody.addEventListener("drop", (e) => {
      e.preventDefault();
      composerBody.classList.remove("dragover");
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
            uploadAndInsert(f);
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
    const fields: HTMLElement[] = [ta, subjectEl, slugEl];
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

  const warningsEl = $("#warnings");
  function showWarnings(ws: string[] | null | undefined) {
    setHtml(
      warningsEl,
      ws?.length
        ? html`<div class="warnings"><strong>Warnings:</strong> ${ws.join("; ")}</div>`
        : html``,
    );
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
    // Pre-fill with saved defaults (don't clobber anything already typed).
    api<SettingsResponse>("/api/settings")
      .then((s) => {
        const defaults = s.settings.testRecipients || [];
        if (defaults.length && !to.value.trim()) {
          to.value = defaults.join("\n");
          m.clearError(); // an empty-field error raised before the defaults arrived no longer holds
          const hint = $("#testDefaultsHint", m.el);
          hint.textContent = "Pre-filled from your default test recipients (Settings).";
          hint.hidden = false;
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
          if (!locked) {
            await saveDraft(true);
          }
          // One request per address, each on its own, so one that fails doesn't stop the
          // rest, and the dialog can name exactly the ones to try again.
          let sent = 0;
          const failed: string[] = [];
          const reasons = new Set<string>(); // each distinct reason once, in the order met
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
                failed.push(addr);
              }
              lastWarnings = r.warnings;
            } catch (e) {
              // A post that's gone, or a session that ended, ends the loop: every address
              // after it would fail the same way.
              if (isNotFound(e) || (e instanceof ApiError && e.status === 401)) {
                throw e;
              }
              failed.push(addr);
              reasons.add(describeError(e));
            }
          }
          showWarnings(lastWarnings);
          // A test of a scheduled post settles its re-made condition on the server; read the
          // feed now so the banner's line goes with it rather than at the next idle read.
          if (locked && sent > 0) {
            readSendsNow();
          }
          if (failed.length) {
            // The dialog stays open with only the addresses that didn't get it, so Send again
            // tries those and no one gets a second copy.
            to.value = failed.join("\n");
            const which = failed.join(", ");
            const why = reasons.size ? ` ${[...reasons].join(" ")}` : "";
            m.error(
              sent
                ? `Sent to ${sent} of ${addrs.length}. Not sent to ${which}.${why} Send again to try those.`
                : `Not sent.${why} Send again to try.`,
            );
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
      const minStr = toLocalInput(earliestFireAt());
      const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
      // While no provider is connected the server would refuse both views, so the dialog
      // drops the picker and the Send now row and leaves only the standing line (DESIGN §4).
      const notConnected = providerNotConnected();
      const scheduleView = html`<h3 id="schHead">Schedule this post</h3><p class="hint">It sends at the time you pick (at least ${minLeadText()} out), with a cancelable window until then.</p>${notConnectedScheduleLine()}${notConnected ? null : html`<label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}">`}<div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>${notConnected ? null : html`<div class="altrow"><span class="altrow-note">Skip the review window?</span><button type="button" class="linkbtn" id="toSendNow">Send now →</button></div>`}`;
      const m = modal(scheduleView, signal);
      const box = $(".modal", m.el);
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

      const doSchedule = () =>
        busy($<HTMLButtonElement>("#schGo", box), "Scheduling…", async () => {
          m.clearError();
          const whenEl = $<HTMLInputElement>("#schWhen", box);
          const t = whenEl.value ? new Date(whenEl.value).getTime() : Number.NaN;
          if (Number.isNaN(t)) {
            m.error("Pick a valid date & time", whenEl);
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
            await api<ScheduleResponse>(`/api/posts/${id}/schedule`, {
              method: "POST",
              json: { fire_at: new Date(t).toISOString() },
            });
            m.close();
            // Stay on the post, re-rendered in its scheduled state: the window is the
            // review and this page is the review surface (SPEC §6, DESIGN §3).
            toast(withNoProviderNote(`Scheduled for ${fmt(t)}. Send yourself a test.`));
            remount();
          } catch (e) {
            if (isNotFound(e)) {
              m.close();
              foundGone(e);
              return;
            }
            m.error(message(e));
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
            });
            m.close();
            toast(withNoProviderNote(`Sends at ${fmt(send.fire_at)}, cancelable until then.`));
            remount();
          } catch (e) {
            if (isNotFound(e)) {
              m.close();
              foundGone(e);
              return;
            }
            m.error(message(e));
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
        $("#schWhen", box).focus();
      }

      async function showSendNow() {
        setHtml(
          box,
          html`<h3 id="snHead">Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong id="snWho">your confirmed subscribers</strong> after a cancelable window of at least ${minLeadText()}, on the minute. You can cancel until it fires.</p><div class="altrow altrow-top"><button type="button" class="linkbtn" id="toSchedule">← Back to schedule</button></div><div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`,
        );
        box.setAttribute("aria-labelledby", "snHead");
        $("#snCancel", box).onclick = m.close;
        $("#snGo", box).onclick = doSendNow;
        $<HTMLButtonElement>("#snGo", box).disabled = providerNotConnected();
        $("#toSchedule", box).onclick = () => {
          setHtml(box, scheduleView);
          wireSchedule();
        };
        $("#snGo", box).focus();
        // Fill the count once known; the copy reads sensibly until then. A send reaches the
        // confirmed addresses that aren't suppressed (SPEC §6), so ask the server for that set's
        // total rather than the confirmed count, which still includes the suppressed ones.
        try {
          const s = await api<SubscriberListResponse>(
            "/api/subscribers?status=confirmed&suppressed=hide&limit=1",
            { signal },
          );
          const n = s.page.total;
          const whoEl = box.querySelector("#snWho"); // gone if the view flipped back meanwhile
          if (whoEl) {
            whoEl.textContent = `${n} confirmed subscriber${n === 1 ? "" : "s"}`;
          }
        } catch {}
      }

      wireSchedule();
    };
  }
  return handle;
}

/** What the scheduled banner reads of its send. `actions` is absent only until the send's
 *  own read answers (the post's read does not carry them). */
type BannerSend = Pick<SendView, "id" | "fire_at" | "phase" | "conditions" | "remade_at"> &
  Partial<Pick<SendView, "actions">>;

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
  if (has(send, "missed")) {
    return html`Scheduled for <strong>${fmt(send.fire_at)}</strong> · <span class="countdown countdown-missed">${lateStr(send.fire_at)}</span>`;
  }
  if (due) {
    return html`Scheduled for <strong>${fmt(send.fire_at)}</strong> · <span class="countdown">${untilStr(send.fire_at, true)}</span>`;
  }
  return html`Scheduled for <strong>${fmt(send.fire_at)}</strong> · <span class="countdown">${untilStr(send.fire_at)}</span> · cancelable until then.`;
}

/** Whether a read or write found its post (or its send, which goes with it) gone. */
function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

/** Where a post's send now lives, when that is no longer the editor: the watch while it
 *  sends, the record once it has sent. */
function sendHome(data: PostResponse): string | null {
  if (data.sending) {
    return `#/sent/${data.sending.id}`;
  }
  if (data.post.status === "sent") {
    return data.sent ? `#/sent/${data.sent.id}` : "#/sent";
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
