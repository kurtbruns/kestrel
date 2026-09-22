// The post editor: subject/slug, the Markdown composer, autosave with its idle and
// hard-cap timers, the freshness poll, images, and the schedule / send-now dialogs.

import type { ImageUploadResponse } from "../../shared/images";
import type {
  PostEditBody,
  PostResponse,
  PostSavedResponse,
  TestSendResponse,
} from "../../shared/posts";
import type { ScheduleResponse } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import { slugify } from "../../shared/slug";
import type { SubscriberListResponse } from "../../shared/subscribers";
import { ApiError, api, apiText } from "../api";
import { withNoProviderNote } from "../deployment";
import { every, mount, onAbort, type ViewHandle } from "../lifecycle";
import { openRescheduleModal } from "../sends/dialogs";
import { appliedNoticeHtml } from "../settings/remake";
import { $, $$ } from "../ui/dom";
import { fmt, parseAddresses, toLocalInput } from "../ui/format";
import { highlightMarkdown } from "../ui/highlight";
import { html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { notice } from "../ui/notice";
import { busy, infoTip, modal, renderError, toast } from "../ui/widgets";
import { createAutosave } from "./autosave";
import { DirtyTracker } from "./dirty";
import { type Author, type Conflict, conflictFromError, RevisionTracker } from "./revisions";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  setHtml(root, html`<p class="muted">Loading…</p>`);
  let data: PostResponse;
  try {
    data = await api<PostResponse>(`/posts/${id}`, { signal });
    if (signal.aborted) {
      return; // navigated away while loading: the redirects below must not hijack that
    }
    // A sent post is a frozen record, not editable (#147/#148): it opens the sent
    // record view, never the editor. Redirect a stale #/edit link (or a post sent in
    // another tab / by Claude) there instead of a locked editor.
    if (data.post.status === "sent") {
      location.hash = data.sent ? `#/sent/${data.sent.id}` : "#/sent";
      return;
    }
    // A post whose send is in flight is no longer an editable/cancelable scheduled draft —
    // it's an active send. Send a direct #/edit link to the live watch, not a soft-locked
    // editor with a dead Cancel (#162).
    if (data.sending) {
      location.hash = `#/sent/${data.sending.id}`;
      return;
    }
  } catch (e) {
    renderError(root, message(e), remount);
    return;
  }
  const { post, markdown, scheduled } = data;

  // The editor now only ever mounts a draft or a scheduled (frozen) post, so `locked`
  // means scheduled — signaled by the scheduled banner, not a status pill (#147).
  const locked = post.status !== "draft";
  // The revision this editor is based on, for optimistic concurrency (SPEC §4).
  // Advanced on each successful save; carried on every save so the server rejects
  // (409) rather than clobbers a newer save from another tab or from Claude.
  const revisions = new RevisionTracker(post.current_revision);
  // A scheduled post keeps its formatting toolbar in view, greyed. The buttons take
  // aria-disabled rather than disabled so a click still reaches applyFormat, whose locked
  // branch nudges the foot line, the way out (DESIGN §7).
  const toolbarHtml = TOOLBAR.map(
    (group, i) =>
      html`${i ? html`<span class="sep"></span>` : null}${group.map(
        ([kind, label]) =>
          html`<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}"${locked ? ARIA_DISABLED : null}>${icon(kind)}</button>`,
      )}`,
  );
  // readonly, not disabled: a scheduled post's text can still be read, selected, and
  // copied; only a change is refused (DESIGN §7).
  const ro = locked ? READONLY : null;
  // The notice slot (#editorNotices, DESIGN §2 home ⑥) sits between the scheduled banner
  // and the conflict banner, so the top of the editor reads state, then event, then
  // decision. Empty, it has no height; notice() renders into it.

  setHtml(
    root,
    html`
    <div class="editor-head">
      <a href="#/drafts" class="back">← Drafts</a>
      <div class="editor-head-right">
        <button type="button" class="ghost" id="openBtn">Open in browser ↗</button>
      </div>
    </div>
    ${locked && scheduled ? html`<div class="banner banner-scheduled"><span>Scheduled for <strong>${fmt(scheduled.fire_at)}</strong>, cancelable until it sends.</span><span class="row"><button type="button" class="ghost" id="rescheduleSchedule">Reschedule</button><button type="button" class="ghost" id="cancelSchedule">Cancel</button></span></div>` : null}
    <div id="editorNotices"></div>
    <div id="freshnessBanner" class="banner banner-conflict" role="alert" hidden></div>
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${post.subject}" aria-describedby="f-subject-error"${ro}><div class="field-error" id="f-subject-error" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span>Add a subject before you schedule.</span></div></div>
        <div>
          <div class="label-row">
            <label for="f-slug">Slug</label>
            ${infoTip("The web address of this post's archive page.")}
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
          <iframe id="previewFrame" class="preview" sandbox="allow-same-origin" title="Email preview" hidden></iframe>
        </div>
        ${
          locked
            ? html`<div class="composer-foot composer-foot-lock" id="lockFoot" role="status">${icon("readonly")}<span>Cancel the schedule to edit</span></div>`
            : html`<div class="composer-foot" id="dropFoot">${icon("paperclip")}<span>Paste, drop, or click to add images</span></div>`
        }
        <input type="file" id="imgInput" accept="image/*" multiple hidden>
      </div>
      <div id="warnings"></div>

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

  // Syntax-highlight overlay (issue #138): a transparent <textarea> over a highlighted
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

  const collect = () => ({ subject: subjectEl.value, slug: slugEl.value, markdown: ta.value });

  // --- subject validation (SPEC §6: freeze() rejects a subjectless send) ---
  // Surfaced on the field, not by disabling the button. The old guard greyed out
  // Schedule and hung the reason in a `title` on the row — invisible to keyboard,
  // touch, and screen readers. Instead Schedule stays live and we validate on click:
  // an empty subject puts the input into an error state with the reason directly
  // beneath it (DESIGN §2, home ④), tied by aria-describedby and announced (role=alert).
  const subjectErrEl = $("#f-subject-error");
  function clearSubjectError() {
    subjectEl.classList.remove("is-invalid");
    subjectErrEl.hidden = true;
  }
  // Gates both send paths (the scheduled send and the in-modal Send now both open
  // from Schedule): true when a subject is present; otherwise shows the error, moves
  // focus to the field, and returns false so the modal never opens.
  function validateSubject() {
    if (subjectEl.value.trim() === "") {
      subjectEl.classList.add("is-invalid");
      subjectErrEl.hidden = false;
      subjectEl.focus();
      return false;
    }
    clearSubjectError();
    return true;
  }

  // Auto-generate slug from subject. The slug stays editable throughout; the
  // checkbox reflects whether it's currently tracking the subject. Typing your
  // own slug takes manual control (unchecks); emptying the field, or ticking the
  // box, re-links and re-derives. The initial mode is inferred from the stored
  // slug, and an empty slug is never left behind.
  if (!locked) {
    const autoEl = $<HTMLInputElement>("#f-slug-auto");
    const derive = () => slugify(subjectEl.value);

    // Infer the starting mode: auto when the slug is empty, equals the derived
    // slug, or is a deduped variant of it (base-2, base-3, …). A hand-written
    // slug that has diverged starts as a custom (unchecked) slug.
    const base = derive();
    const v = slugEl.value.trim();
    autoEl.checked =
      v === "" || v === base || (base !== "" && new RegExp(`^${base}-\\d+$`).test(v));

    // Muted while it tracks the subject; normal color once it's a hand-set slug.
    const reflect = () => slugEl.classList.toggle("slug-auto", autoEl.checked);
    reflect();
    if (autoEl.checked && v === "") {
      slugEl.value = derive();
    }

    subjectEl.addEventListener("input", () => {
      if (autoEl.checked) {
        slugEl.value = derive();
      }
    });
    // Typing a slug takes manual control; clearing it re-links to the subject.
    slugEl.addEventListener("input", () => {
      autoEl.checked = slugEl.value.trim() === "";
      reflect();
    });
    // Ticking the box re-derives; unticking hands over the field ready to edit.
    autoEl.addEventListener("change", () => {
      reflect();
      if (autoEl.checked) {
        slugEl.value = derive();
      } else {
        slugEl.focus();
        slugEl.select();
      }
      markEdited(); // the checkbox mutates the slug without an input event
    });
    // Never leave an empty slug: on blur, fall back to the subject-derived one.
    slugEl.addEventListener("blur", () => {
      if (slugEl.value.trim() === "") {
        autoEl.checked = true;
        reflect();
        slugEl.value = derive();
        markEdited();
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
    saveDraft(true).catch((e) => toast(`Couldn't autosave — ${message(e)}`));
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
    if (name === "edit") {
      syncMdScroll();
    }
  }
  async function showPreview() {
    showTab("preview");
    try {
      if (!locked) {
        await saveDraft(true);
      }
      previewFrame.srcdoc = await apiText(`/posts/${id}/preview`);
      previewFrame.onload = () => {
        try {
          const doc = previewFrame.contentDocument;
          if (doc) {
            previewFrame.style.height = `${doc.body.scrollHeight + 24}px`;
          }
        } catch {}
      };
    } catch (e) {
      toast(message(e));
    }
  }
  for (const t of tabs) {
    t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("edit"));
  }
  // A scheduled post opens on Preview: the preview is the copy that will send, and the
  // Edit tab is read-only, so it is somewhere the publisher goes deliberately and finds
  // the way out written on it (DESIGN §7).
  if (locked) {
    showPreview();
  }

  // --- the lock's nudge ---
  // A scheduled post refuses edits at the browser (readonly) and at the API (SPEC §6). When
  // one is attempted anyway, the foot's "Cancel the schedule to edit" pulses once, so the
  // way out is seen where the keystroke landed rather than announced elsewhere (DESIGN §7).
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
    try {
      const body: PostEditBody = { ...fields, base_revision: revisions.base };
      const { post: u } = await api<PostSavedResponse>(`/posts/${id}`, {
        method: "PUT",
        json: body,
      });
      // Reflect server-side dedupe, but don't yank the slug from under the cursor
      // if an autosave lands while the field is focused.
      if (u.slug && document.activeElement !== slugEl) {
        slugEl.value = u.slug;
      }
      revisions.saved(u.current_revision); // our save is now the newest; poll against it
      dirty.markSaved(sent);
      saveFailed = false;
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
      saveFailed = true; // the leave guard now prompts rather than silently flushing
      throw e;
    } finally {
      saving = false;
      refreshDirty();
    }
  }
  if (saveBtn) {
    saveBtn.onclick = () =>
      busy(saveBtn, "Saving…", () => saveDraft(false).catch((e) => toast(message(e)))).finally(
        refreshDirty,
      );
  }

  // Leaving the editor saves in the background instead of prompting. Capture the
  // payload NOW (the mount tears down the DOM right after) and send it through
  // the chain so it can't overlap an in-flight save. Deliberately not bound to the
  // signal: a save the reader started must land whether or not they stayed to watch.
  const leaveFlush = () => {
    mine.cancel();
    if (locked || !dirty.dirty) {
      return;
    }
    const body: PostEditBody = { ...collect(), base_revision: revisions.base };
    dirty.markSaved();
    editorDirty = false;
    saveChain = saveChain
      .catch(() => {})
      .then(() => api<PostSavedResponse>(`/posts/${id}`, { method: "PUT", json: body }))
      .catch((e) =>
        toast(
          e instanceof ApiError && e.status === 409
            ? "Changed elsewhere — your edits weren't saved"
            : `Couldn't save your changes — ${message(e)}`,
        ),
      );
  };
  const handle: ViewHandle = {
    dirty: () => editorDirty,
    beforeLeave() {
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

  // Typed edits mark dirty; blurring subject/slug flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    for (const el of [subjectEl, slugEl, ta]) {
      el.addEventListener("input", markEdited);
    }
    for (const el of [subjectEl, slugEl]) {
      el.addEventListener("blur", () =>
        saveDraft(true).catch((e) => toast(`Couldn't save — ${message(e)}`)),
      );
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
    revisions.clearWarning();
    freshnessEl.hidden = true;
    setHtml(freshnessEl, html``);
  }
  function showConflict(conflict: Conflict) {
    if (locked) {
      return;
    }
    conflicted = true; // pauses autosave; makes the leave guard prompt
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
        html`<span><span aria-hidden="true">⚠️</span> This draft was changed elsewhere${who ? html` — last edited by <strong>${who}</strong>` : null}. Reload to load that version (discards your unsaved edits), or keep editing to overwrite it on your next save.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button><button type="button" class="ghost" id="freshKeep">Keep editing</button></span>`,
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

  if (!locked) {
    // Skipped while hidden, saving, or already warned — poll GET is cheap and only
    // re-warns on a revision we haven't surfaced yet.
    const pollFreshness = async () => {
      if (saving || conflicted || document.hidden) {
        return;
      }
      const baseAtRequest = revisions.base; // to tell our own save landing mid-poll from another writer's
      try {
        const fresh = await api<PostResponse>(`/posts/${id}`, { signal });
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
      } catch {
        /* transient — try again next tick */
      }
    };
    every(10000, pollFreshness, signal);
  } else {
    // A scheduled post is soft-locked here (read-only, showing the scheduled banner). If its
    // send FIRES while the editor is open, it's no longer a cancelable scheduled draft — it's
    // an active send — so redirect to the live watch, the same as opening it fresh would
    // (#162). Likewise jump to the record if it finishes while we're sitting here.
    const pollSchedule = async () => {
      if (document.hidden) {
        return;
      }
      try {
        const fresh = await api<PostResponse>(`/posts/${id}`, { signal });
        if (signal.aborted) {
          return; // a redirect must not hijack where the reader went meanwhile
        }
        if (fresh.sending) {
          location.hash = `#/sent/${fresh.sending.id}`;
        } else if (fresh.post.status === "sent") {
          location.hash = fresh.sent ? `#/sent/${fresh.sent.id}` : "#/sent";
        }
      } catch {
        /* transient — try again next tick */
      }
    };
    every(10000, pollSchedule, signal);
  }

  // --- open in browser ---
  const openBtn = $<HTMLButtonElement>("#openBtn");
  openBtn.onclick = () =>
    busy(openBtn, "Opening…", async () => {
      try {
        if (!locked) {
          await saveDraft(true);
        }
        const page = await apiText(`/posts/${id}/preview`);
        const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(message(e));
      }
    });

  if (locked && scheduled) {
    // --- reschedule (from the scheduled banner): move the fire time, content stays frozen ---
    const rescheduleBtn = $<HTMLButtonElement>("#rescheduleSchedule");
    rescheduleBtn.onclick = () => openRescheduleModal(scheduled.id, scheduled.fire_at, remount);

    // --- the applied-change notice (SPEC §8): an event, read once and cleared ---
    // The same record as the dashboard's aggregate (kind "applied", the send id, its
    // remade_at), so clearing it here clears it there once every member is, and a later
    // change shows it again on its own.
    if (scheduled.remade_at) {
      notice($("#editorNotices"), {
        kind: "applied",
        subject: scheduled.id,
        version: scheduled.remade_at,
        markup: appliedNoticeHtml(scheduled.remade_at, 1, true),
      });
    }

    // --- cancel schedule (from the scheduled banner) ---
    const cancelScheduleBtn = $<HTMLButtonElement>("#cancelSchedule");
    cancelScheduleBtn.onclick = () =>
      busy(cancelScheduleBtn, "Canceling…", async () => {
        try {
          await api(`/sends/${scheduled.id}/cancel`, { method: "POST" });
          toast("Schedule canceled");
          remount();
        } catch (e) {
          toast(message(e));
        }
      });
  }

  // --- image upload: drag/drop, paste, click ---
  async function uploadAndInsert(file: File) {
    if (!file.type.startsWith("image/")) {
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { image } = await api<ImageUploadResponse>(`/posts/${id}/images`, {
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
      toast(message(e));
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
    // the dialog is where that is said (DESIGN §7).
    const lead = locked
      ? "Delivers the frozen copy that will send, exactly as it will fire, so you can check it in a client. One address per line."
      : "Delivers the rendered email to real inboxes so you can check it in a client. One address per line.";
    const m = modal(
      html`<h3>Send a test</h3><p class="hint">${lead}</p><label for="testTo">Recipients</label><textarea id="testTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="testDefaultsHint" hidden></p><div class="actions"><button type="button" id="tCancel">Cancel</button><button type="button" class="primary" id="tGo">Send test</button></div>`,
    );
    const to = $<HTMLTextAreaElement>("#testTo", m.el);
    to.focus();
    // Pre-fill with saved defaults (don't clobber anything already typed).
    api<SettingsResponse>("/api/settings")
      .then((s) => {
        const defaults = s.settings.testRecipients || [];
        if (defaults.length && !to.value.trim()) {
          to.value = defaults.join("\n");
          const hint = $("#testDefaultsHint", m.el);
          hint.textContent = "Pre-filled from your default test recipients (Settings).";
          hint.hidden = false;
        }
      })
      .catch(() => {});
    const go = $<HTMLButtonElement>("#tGo", m.el);
    $("#tCancel", m.el).onclick = m.close;
    go.onclick = () =>
      busy(go, "Sending…", async () => {
        const addrs = parseAddresses(to.value);
        if (!addrs.length) {
          toast("Enter at least one email address");
          return;
        }
        try {
          if (!locked) {
            await saveDraft(true);
          }
          let sent = 0;
          let lastWarnings: string[] | null = null;
          for (const addr of addrs) {
            const r = await api<TestSendResponse>(`/posts/${id}/test`, {
              method: "POST",
              json: { to: addr },
            });
            if (r.sent) {
              sent++;
            }
            lastWarnings = r.warnings;
          }
          showWarnings(lastWarnings);
          m.close();
          toast(
            withNoProviderNote(
              sent === addrs.length
                ? `Test sent to ${sent} address${sent === 1 ? "" : "es"}`
                : `Sent ${sent}/${addrs.length} — some failed`,
            ),
          );
        } catch (e) {
          toast(message(e));
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
      const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
      const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
      const scheduleView = html`<h3 id="schHead">Schedule this post</h3><p class="hint">It sends at the time you pick (at least 5 minutes out), with a cancelable window until then.</p><label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}"><div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div><div class="altrow"><span class="altrow-note">Skip the review window?</span><button type="button" class="linkbtn" id="toSendNow">Send now →</button></div>`;
      const m = modal(scheduleView);
      const box = $(".modal", m.el);

      const doSchedule = () =>
        busy($<HTMLButtonElement>("#schGo", box), "Scheduling…", async () => {
          const v = $<HTMLInputElement>("#schWhen", box).value;
          const t = v ? new Date(v).getTime() : Number.NaN;
          if (Number.isNaN(t)) {
            toast("Pick a valid date & time");
            return;
          }
          try {
            // A refused save means the server holds another writer's newer revision, so
            // scheduling now would freeze content the publisher never saw (SPEC §6).
            // Close the dialog and let the out-of-date banner behind it be the next step.
            if ((await saveDraft(true)) === "refused") {
              m.close();
              return;
            }
            await api<ScheduleResponse>(`/posts/${id}/schedule`, {
              method: "POST",
              json: { fire_at: new Date(t).toISOString() },
            });
            m.close();
            // Stay on the post, re-rendered in its scheduled state: the window is the
            // review and this page is the review surface (SPEC §6, DESIGN §7).
            toast(withNoProviderNote(`Scheduled for ${fmt(t)}. Send yourself a test.`));
            remount();
          } catch (e) {
            toast(message(e));
          }
        });

      const doSendNow = () =>
        busy($<HTMLButtonElement>("#snGo", box), "Queuing…", async () => {
          try {
            // As in doSchedule: a refused save must not become a frozen send.
            if ((await saveDraft(true)) === "refused") {
              m.close();
              return;
            }
            await api<ScheduleResponse>(`/posts/${id}/send`, { method: "POST" });
            m.close();
            toast(withNoProviderNote("Sends in 5 minutes, cancelable until then."));
            remount();
          } catch (e) {
            toast(message(e));
          }
        });

      function wireSchedule() {
        box.setAttribute("aria-labelledby", "schHead");
        $("#schCancel", box).onclick = m.close;
        $("#schGo", box).onclick = doSchedule;
        $("#toSendNow", box).onclick = showSendNow;
        $("#schWhen", box).focus();
      }

      async function showSendNow() {
        setHtml(
          box,
          html`<h3 id="snHead">Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong id="snWho">your confirmed subscribers</strong> after a 5-minute cancelable window. You can cancel until it fires.</p><div class="altrow altrow-top"><button type="button" class="linkbtn" id="toSchedule">← Back to schedule</button></div><div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`,
        );
        box.setAttribute("aria-labelledby", "snHead");
        $("#snCancel", box).onclick = m.close;
        $("#snGo", box).onclick = doSendNow;
        $("#toSchedule", box).onclick = () => {
          setHtml(box, scheduleView);
          wireSchedule();
        };
        $("#snGo", box).focus();
        // Fill the real confirmed-subscriber count once known; the copy reads sensibly until then.
        try {
          const s = await api<SubscriberListResponse>("/subscribers");
          const n = s.counts.confirmed;
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
