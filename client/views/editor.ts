// @ts-nocheck
// The post editor: subject/slug, the Markdown composer, autosave with its idle and
// hard-cap timers, the freshness poll, images, and the schedule / send-now dialogs.

import { slugify } from "../../shared/slug";
import { api, apiText } from "../api";
import { withNoProviderNote } from "../build_ref";
import { esc, fmt, modal, parseAddresses, toast, toLocalInput } from "../helpers";
import { highlightMarkdown } from "../highlight";
import { icon } from "../icons";
import { busy, notice, renderError } from "../notice";
import { appliedNoticeHtml } from "../remake";
import { infoTip } from "../savebar";
import { app } from "../shell";
import { appState } from "../state";
import { openRescheduleModal } from "./sends";

// Autosave uses two timers (see scheduleAutosave): save after a short idle pause,
// but never let an edit sit unsaved longer than the hard cap even while typing.
let autosaveIdleTimer = null;
let autosaveCapTimer = null;
const IDLE_MS = 5000; // quiet pause before a background save
const MAX_MS = 30000; // hard cap: no edit stays unsaved longer than this
export function clearAutosaveTimers() {
  if (autosaveIdleTimer) {
    clearTimeout(autosaveIdleTimer);
    autosaveIdleTimer = null;
  }
  if (autosaveCapTimer) {
    clearTimeout(autosaveCapTimer);
    autosaveCapTimer = null;
  }
}
export const LEAVE_MSG = "You have unsaved changes. Leave without saving?";

const TOOLBAR = [
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

export async function renderEditor(id) {
  clearAutosaveTimers();
  // Reload (and cancel-schedule / error-retry) re-enter renderEditor directly, without
  // going through route(), so clear the previous mount's freshness poll here too — an
  // orphaned interval would keep firing on a stale baseRevision closure and wrongly
  // flip editorConflict, silently blocking saves in the fresh editor.
  if (appState.editorPollTimer) {
    clearInterval(appState.editorPollTimer);
    appState.editorPollTimer = null;
  }
  appState.isEditorDirty = false;
  appState.editorSaveFailed = false;
  appState.editorConflict = false;
  appState.editorHash = null; // fresh mount starts clean; the tracking block below re-establishes the hash
  appState.editorLeaveFlush = null;
  appState.editorManualSave = null;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown, scheduled;
  try {
    const data = await api(`/posts/${id}`);
    post = data.post;
    markdown = data.markdown;
    scheduled = data.scheduled;
    // A sent post is a frozen record, not editable (#147/#148): it opens the sent
    // record view, never the editor. Redirect a stale #/edit link (or a post sent in
    // another tab / by Claude) there instead of a locked editor.
    if (post.status === "sent") {
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
    renderError(app, e.message, () => renderEditor(id));
    return;
  }

  // The editor now only ever mounts a draft or a scheduled (frozen) post, so `locked`
  // means scheduled — signaled by the scheduled banner, not a status pill (#147).
  const locked = post.status !== "draft";
  // The revision this editor is based on, for optimistic concurrency (SPEC §4).
  // Advanced on each successful save; carried on every save so the server rejects
  // (409) rather than clobbers a newer save from another tab or from Claude.
  let baseRevision = post.current_revision;
  let warnedRevision = null; // newest revision we've surfaced, so we re-arm only on a genuinely newer one
  // A scheduled post keeps its formatting toolbar in view, greyed. The buttons take
  // aria-disabled rather than disabled so a click still reaches applyFormat, whose locked
  // branch nudges the foot line, the way out (DESIGN §7).
  const toolbarHtml = TOOLBAR.map((group) =>
    group
      .map(
        ([kind, label]) =>
          `<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}"${locked ? ' aria-disabled="true"' : ""}>${icon(kind)}</button>`,
      )
      .join(""),
  ).join(`<span class="sep"></span>`);
  // readonly, not disabled: a scheduled post's text can still be read, selected, and
  // copied; only a change is refused (DESIGN §7).
  const ro = locked ? "readonly" : "";
  // The notice slot (#editorNotices, DESIGN §2 home ⑥) sits between the scheduled banner
  // and the conflict banner, so the top of the editor reads state, then event, then
  // decision. Empty, it has no height; notice() renders into it.

  app.innerHTML = `
    <div class="editor-head">
      <a href="#/drafts" class="back">← Drafts</a>
      <div class="editor-head-right">
        <button type="button" class="ghost" id="openBtn">Open in browser ↗</button>
      </div>
    </div>
    ${locked && scheduled ? `<div class="banner banner-scheduled"><span>Scheduled for <strong>${esc(fmt(scheduled.fire_at))}</strong>, cancelable until it sends.</span><span class="row"><button type="button" class="ghost" id="rescheduleSchedule">Reschedule</button><button type="button" class="ghost" id="cancelSchedule">Cancel</button></span></div>` : ""}
    <div id="editorNotices"></div>
    <div id="freshnessBanner" class="banner banner-conflict" role="alert" hidden></div>
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${esc(post.subject)}" aria-describedby="f-subject-error" ${ro}><div class="field-error" id="f-subject-error" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span>Add a subject before you schedule.</span></div></div>
        <div>
          <div class="label-row">
            <label for="f-slug">Slug</label>
            ${infoTip("The web address of this post's archive page.")}
          </div>
          <input id="f-slug" value="${esc(post.slug)}" ${ro}>
          ${locked ? "" : `<label class="slug-auto-toggle"><input type="checkbox" id="f-slug-auto">Auto-generate from subject</label>`}
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
          <textarea id="f-markdown" class="editor"${locked ? "" : ' placeholder="Type your post in Markdown…"'} ${ro}>${esc(markdown)}</textarea>
          <iframe id="previewFrame" class="preview" sandbox="allow-same-origin" title="Email preview" hidden></iframe>
        </div>
        ${
          locked
            ? `<div class="composer-foot composer-foot-lock" id="lockFoot" role="status">${icon("readonly")}<span>Cancel the schedule to edit</span></div>`
            : `<div class="composer-foot" id="dropFoot">${icon("paperclip")}<span>Paste, drop, or click to add images</span></div>`
        }
        <input type="file" id="imgInput" accept="image/*" multiple hidden>
      </div>
      <div id="warnings"></div>

      <div class="actions-bar">
        ${
          locked
            ? `<div class="row"><button type="button" class="secondary" id="testBtn">${icon("send")}<span>Send test email</span></button></div>`
            : `<div class="row">
                 <button type="button" class="ghost" id="saveBtn">Save draft</button>
                 <span class="save-status" id="saveStatus" aria-live="polite"></span>
               </div>
               <div class="row">
                 <button type="button" class="secondary" id="testBtn">${icon("send")}<span>Send test email</span></button>
                 <button type="button" class="primary" id="scheduleBtn">Schedule</button>
               </div>`
        }
      </div>
    </div>`;

  const ta = document.getElementById("f-markdown");
  const toolbarEl = app.querySelector(".toolbar");
  const previewFrame = document.getElementById("previewFrame");

  // Syntax-highlight overlay (issue #138): a transparent <textarea> over a highlighted
  // <pre>, kept in scroll sync — the template editor's scaffolding, tokenizing Markdown.
  // Prose soft-wraps, so both layers share pre-wrap and identical metrics (the caret lands
  // on the colored text); that wrapping is also why there's no line-number gutter — a
  // number can't track a wrapped line and prose doesn't want one. The highlight is the point.
  const mdHl = document.getElementById("mdHl");
  const mdHlCode = mdHl.querySelector("code");
  const syncMdScroll = () => {
    mdHl.scrollTop = ta.scrollTop;
    mdHl.scrollLeft = ta.scrollLeft;
  };
  const paintMarkdown = () => {
    // highlightMarkdown emits one block row per source line (split on "\n"), so the row count —
    // and thus the overlay height — already tracks the textarea, including a trailing blank line.
    mdHlCode.innerHTML = highlightMarkdown(ta.value);
    syncMdScroll();
  };
  ta.addEventListener("scroll", syncMdScroll);
  paintMarkdown(); // paint the initial content (a scheduled post is read-only but still highlighted)

  const get = (k) => document.getElementById(`f-${k}`).value;
  const collect = () => ({ subject: get("subject"), slug: get("slug"), markdown: get("markdown") });

  // --- subject validation (SPEC §6: freeze() rejects a subjectless send) ---
  // Surfaced on the field, not by disabling the button. The old guard greyed out
  // Schedule and hung the reason in a `title` on the row — invisible to keyboard,
  // touch, and screen readers. Instead Schedule stays live and we validate on click:
  // an empty subject puts the input into an error state with the reason directly
  // beneath it (DESIGN §2, home ④), tied by aria-describedby and announced (role=alert).
  const subjectErrEl = document.getElementById("f-subject-error");
  function clearSubjectError() {
    document.getElementById("f-subject").classList.remove("is-invalid");
    if (subjectErrEl) {
      subjectErrEl.hidden = true;
    }
  }
  // Gates both send paths (the scheduled send and the in-modal Send now both open
  // from Schedule): true when a subject is present; otherwise shows the error, moves
  // focus to the field, and returns false so the modal never opens.
  function validateSubject() {
    const el = document.getElementById("f-subject");
    if (el.value.trim() === "") {
      el.classList.add("is-invalid");
      if (subjectErrEl) {
        subjectErrEl.hidden = false;
      }
      el.focus();
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
    const subjectEl = document.getElementById("f-subject");
    const slugEl = document.getElementById("f-slug");
    const autoEl = document.getElementById("f-slug-auto");
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

  // --- tabs ---
  const tabs = app.querySelectorAll(".ctab");
  function showTab(name) {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
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
          previewFrame.style.height = `${previewFrame.contentDocument.body.scrollHeight + 24}px`;
        } catch (_) {}
      };
    } catch (e) {
      toast(e.message);
    }
  }
  tabs.forEach((t) => {
    t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("edit"));
  });
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
  const lockFoot = document.getElementById("lockFoot");
  let nudgeTimer = null;
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
  function wrapSel(before, after, placeholder) {
    const s = ta.selectionStart,
      e = ta.selectionEnd,
      sel = ta.value.slice(s, e) || placeholder;
    ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart,
      e = ta.selectionEnd,
      start = ta.value.lastIndexOf("\n", s - 1) + 1;
    const out = (ta.value.slice(start, e) || "")
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = start + out.length;
  }
  function applyFormat(kind) {
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
      const s = ta.selectionStart,
        e = ta.selectionEnd;
      if (s === e || ta.value.slice(s, e).includes("\n")) {
        wrapSel("```\n", "\n```", "code");
      } else {
        wrapSel("`", "`", "code");
      }
    }
    markEdited();
  }
  app.querySelectorAll(".tb[data-fmt]").forEach((b) => {
    b.onclick = () => applyFormat(b.dataset.fmt);
  });
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
  // button, guard navigation (at the router, via isEditorDirty), and autosave.
  appState.editorHash = location.hash;
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");
  const snapshot = () => JSON.stringify(collect());
  let savedSnapshot = snapshot();
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
    } else if (appState.isEditorDirty) {
      saveStatus.className = "save-status is-dirty";
      saveStatus.textContent = "Unsaved changes";
    } else {
      saveStatus.className = "save-status is-saved";
      saveStatus.textContent = "Saved";
    }
  }
  function refreshDirty() {
    appState.isEditorDirty = snapshot() !== savedSnapshot;
    renderSaveStatus();
  }
  renderSaveStatus(); // paint the initial state (Saved on a fresh draft; empty if locked)
  // Autosave: save after IDLE_MS of quiet, but never let an edit sit unsaved
  // longer than MAX_MS even during continuous typing (the idle timer keeps
  // resetting; the cap timer, started on the first edit after a save, does not).
  // Manual Save + ⌘S stays the primary path; this is the safety net.
  function scheduleAutosave() {
    if (autosaveIdleTimer) {
      clearTimeout(autosaveIdleTimer);
    }
    autosaveIdleTimer = setTimeout(runAutosave, IDLE_MS);
    if (!autosaveCapTimer) {
      autosaveCapTimer = setTimeout(runAutosave, MAX_MS);
    }
  }
  function runAutosave() {
    clearAutosaveTimers();
    saveDraft(true).catch((e) => toast(`Couldn't autosave — ${e.message}`)); // surface failures, never lose silently
  }
  // Called after any edit — typed, formatted, or an inserted image.
  function markEdited() {
    if (locked) {
      return;
    }
    paintMarkdown(); // repaint the highlight overlay from the new textarea value
    refreshDirty();
    if (!appState.editorConflict) {
      scheduleAutosave();
    }
  }

  // Saves are chained so an autosave and an explicit save can never overlap; a
  // silent save with nothing pending is skipped.
  let saveChain = Promise.resolve();
  function saveDraft(silent) {
    saveChain = saveChain.catch(() => {}).then(() => doSaveDraft(silent));
    return saveChain;
  }
  async function doSaveDraft(silent) {
    if (silent && snapshot() === savedSnapshot) {
      return null; // nothing changed since the last save
    }
    if (appState.editorConflict) {
      return null; // paused until the out-of-date banner is resolved
    }
    clearAutosaveTimers(); // a save is starting — cancel any pending autosave trigger
    saving = true;
    renderSaveStatus(); // reflect Saving… right away; the finally re-renders when done
    try {
      const { post: u } = await api(`/posts/${id}`, {
        method: "PUT",
        json: { ...collect(), base_revision: baseRevision },
      });
      const slugEl = document.getElementById("f-slug");
      // Reflect server-side dedupe, but don't yank the slug from under the cursor
      // if an autosave lands while the field is focused.
      if (u?.slug && slugEl && document.activeElement !== slugEl) {
        slugEl.value = u.slug;
      }
      baseRevision = u.current_revision; // our save is now the newest; poll against it
      savedSnapshot = snapshot();
      appState.editorSaveFailed = false;
      if (!silent) {
        toast("Saved");
      }
      return u;
    } catch (e) {
      // A stale-revision 409 isn't a plain failure: another writer got there first.
      // Surface the out-of-date banner (notify, don't clobber) instead of an error toast.
      if (e && e.status === 409) {
        showConflict(
          e.data && e.data.error === "stale_revision"
            ? { current_revision: e.data.current_revision, author: e.data.author }
            : { schedLocked: true },
        );
        return null;
      }
      appState.editorSaveFailed = true; // the leave guard now prompts rather than silently flushing
      throw e;
    } finally {
      saving = false;
      refreshDirty();
    }
  }
  if (saveBtn) {
    saveBtn.onclick = () =>
      busy(saveBtn, "Saving…", () => saveDraft(false).catch((e) => toast(e.message))).finally(
        refreshDirty,
      );
  }

  // Leaving the editor saves in the background instead of prompting. Capture the
  // payload NOW (the router tears down the DOM right after) and send it through
  // the chain so it can't overlap an in-flight save.
  appState.editorLeaveFlush = () => {
    clearAutosaveTimers();
    if (locked || snapshot() === savedSnapshot) {
      return;
    }
    const body = { ...collect(), base_revision: baseRevision };
    savedSnapshot = JSON.stringify(collect());
    appState.isEditorDirty = false;
    saveChain = saveChain
      .catch(() => {})
      .then(() => api(`/posts/${id}`, { method: "PUT", json: body }))
      .catch((e) =>
        toast(
          e.status === 409
            ? "Changed elsewhere — your edits weren't saved"
            : `Couldn't save your changes — ${e.message}`,
        ),
      );
  };
  appState.editorManualSave = () => {
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.click();
    }
  };

  // Typed edits mark dirty; blurring subject/slug flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    ["f-subject", "f-slug", "f-markdown"].forEach((k) => {
      document.getElementById(k).addEventListener("input", markEdited);
    });
    ["f-subject", "f-slug"].forEach((k) => {
      document
        .getElementById(k)
        .addEventListener("blur", () =>
          saveDraft(true).catch((e) => toast(`Couldn't save — ${e.message}`)),
        );
    });
  }

  // --- concurrent-edit detection (SPEC §4) ---
  // Another tab, or Claude through the API, can save this draft while it's open
  // here. A save carries base_revision so the server rejects a stale write (409);
  // a light poll warns before the writer invests more effort. We notify, never
  // adopt: Reload takes the other version, Keep editing keeps yours (your next
  // save overwrites it). Re-arm only on a genuinely newer revision.
  const freshnessEl = document.getElementById("freshnessBanner");
  const friendlyAuthor = (a) => (a === "service" ? "Claude" : a || null);

  function clearConflict() {
    appState.editorConflict = false;
    warnedRevision = null;
    if (freshnessEl) {
      freshnessEl.hidden = true;
      freshnessEl.innerHTML = "";
    }
  }
  function showConflict(info) {
    if (!freshnessEl || locked) {
      return;
    }
    appState.editorConflict = true; // pauses autosave; makes the leave guard prompt
    if (info.schedLocked) {
      freshnessEl.innerHTML = `<span><span aria-hidden="true">⚠️</span> This draft was scheduled elsewhere and can no longer be edited here.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button></span>`;
    } else {
      warnedRevision = info.current_revision;
      const who = friendlyAuthor(info.author);
      freshnessEl.innerHTML =
        `<span><span aria-hidden="true">⚠️</span> This draft was changed elsewhere${who ? ` — last edited by <strong>${esc(who)}</strong>` : ""}. Reload to load that version (discards your unsaved edits), or keep editing to overwrite it on your next save.</span>` +
        `<span class="row"><button type="button" class="ghost" id="freshReload">Reload</button><button type="button" class="ghost" id="freshKeep">Keep editing</button></span>`;
    }
    freshnessEl.hidden = false;
    freshnessEl.querySelector("#freshReload").onclick = () => {
      clearConflict();
      renderEditor(id);
    };
    const keep = freshnessEl.querySelector("#freshKeep");
    if (keep) {
      keep.onclick = () => {
        baseRevision = warnedRevision; // adopt the newer revision as our base — our next save wins
        clearConflict();
        refreshDirty();
        if (appState.isEditorDirty) {
          scheduleAutosave();
        }
      };
    }
  }

  if (!locked) {
    // Skipped while hidden, saving, or already warned — poll GET is cheap and only
    // re-warns on a revision we haven't surfaced yet.
    const pollFreshness = async () => {
      if (saving || appState.editorConflict || document.hidden) {
        return;
      }
      const baseAtRequest = baseRevision; // guard against our own save landing mid-poll
      try {
        const data = await api(`/posts/${id}`);
        // If our own save advanced the base while this GET was in flight, the response
        // may predate it — don't mistake our write for someone else's.
        if (saving || baseRevision !== baseAtRequest) {
          return;
        }
        if (data.post.status !== "draft") {
          showConflict({ schedLocked: true });
          return;
        }
        const rev = data.post.current_revision;
        if (rev && rev !== baseRevision && rev !== warnedRevision) {
          showConflict({ current_revision: rev, author: data.author });
        }
      } catch (_) {
        /* transient — try again next tick */
      }
    };
    appState.editorPollTimer = setInterval(pollFreshness, 10000);
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
        const data = await api(`/posts/${id}`);
        if (data.sending) {
          location.hash = `#/sent/${data.sending.id}`;
        } else if (data.post.status === "sent") {
          location.hash = data.sent ? `#/sent/${data.sent.id}` : "#/sent";
        }
      } catch (_) {
        /* transient — try again next tick */
      }
    };
    appState.editorPollTimer = setInterval(pollSchedule, 10000);
  }

  // --- open in browser ---
  const openBtn = document.getElementById("openBtn");
  openBtn.onclick = () =>
    busy(openBtn, "Opening…", async () => {
      try {
        if (!locked) {
          await saveDraft(true);
        }
        const html = await apiText(`/posts/${id}/preview`);
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(e.message);
      }
    });

  // --- reschedule (from the scheduled banner): move the fire time, content stays frozen ---
  const rescheduleBtn = document.getElementById("rescheduleSchedule");
  if (rescheduleBtn && scheduled) {
    rescheduleBtn.onclick = () =>
      openRescheduleModal(scheduled.id, scheduled.fire_at, () => renderEditor(id));
  }

  // --- the applied-change notice (SPEC §8): an event, read once and cleared ---
  // The same record as the dashboard's aggregate (kind "applied", the send id, its
  // remade_at), so clearing it here clears it there once every member is, and a later
  // change shows it again on its own.
  if (locked && scheduled?.remade_at) {
    notice(document.getElementById("editorNotices"), {
      kind: "applied",
      subject: scheduled.id,
      version: scheduled.remade_at,
      html: appliedNoticeHtml(scheduled.remade_at, 1, true),
    });
  }

  // --- cancel schedule (from the scheduled banner) ---
  const cancelScheduleBtn = document.getElementById("cancelSchedule");
  if (cancelScheduleBtn && scheduled) {
    cancelScheduleBtn.onclick = () =>
      busy(cancelScheduleBtn, "Canceling…", async () => {
        try {
          await api(`/sends/${scheduled.id}/cancel`, { method: "POST" });
          toast("Schedule canceled");
          renderEditor(id);
        } catch (e) {
          toast(e.message);
        }
      });
  }

  // --- image upload: drag/drop, paste, click ---
  async function uploadAndInsert(file) {
    if (!file?.type.startsWith("image/")) {
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { image } = await api(`/posts/${id}/images`, { method: "POST", body: fd });
      const s = ta.selectionStart,
        snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s + snippet.length;
      markEdited();
      toast("Image added");
    } catch (e) {
      toast(e.message);
    }
  }
  if (!locked) {
    const body = document.getElementById("composerBody"),
      imgInput = document.getElementById("imgInput"),
      foot = document.getElementById("dropFoot");
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("dragover");
    });
    body.addEventListener("dragleave", (e) => {
      if (e.target === body) {
        body.classList.remove("dragover");
      }
    });
    body.addEventListener("drop", (e) => {
      e.preventDefault();
      body.classList.remove("dragover");
      showTab("edit");
      for (const f of e.dataTransfer.files) {
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
      for (const f of imgInput.files) {
        uploadAndInsert(f);
      }
      imgInput.value = "";
    };
  } else {
    // Locked: a key that would change the text, a paste, or a drop is refused (readonly
    // does the refusing; a drop is stopped from opening the file) and nudges the foot.
    // Navigation, selection, and copy keys pass, so reading stays free.
    const body = document.getElementById("composerBody");
    const wouldEdit = (e) => {
      if (e.metaKey || e.ctrlKey) {
        return ["x", "z", "y"].includes(e.key.toLowerCase()); // cut, undo, redo (paste fires its own event)
      }
      return e.key.length === 1 || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete";
    };
    for (const f of [ta, document.getElementById("f-subject"), document.getElementById("f-slug")]) {
      f.addEventListener("keydown", (e) => {
        if (wouldEdit(e)) {
          nudge();
        }
      });
      f.addEventListener("paste", nudge);
    }
    body.addEventListener("dragover", (e) => e.preventDefault());
    body.addEventListener("drop", (e) => {
      e.preventDefault();
      nudge();
    });
  }

  function showWarnings(ws) {
    document.getElementById("warnings").innerHTML = ws?.length
      ? `<div class="warnings"><strong>Warnings:</strong> ${ws.map(esc).join("; ")}</div>`
      : "";
  }

  // --- send test (modal) ---
  // Pre-fills from the default test recipients (Settings) and accepts
  // several — one per line. Each address is a separate test send through the same
  // per-recipient path as a real send (I5).
  document.getElementById("testBtn").onclick = () => {
    // A scheduled post's test is its frozen copy, exactly as it will fire (SPEC §5);
    // the dialog is where that is said (DESIGN §7).
    const lead = locked
      ? "Delivers the frozen copy that will send, exactly as it will fire, so you can check it in a client. One address per line."
      : "Delivers the rendered email to real inboxes so you can check it in a client. One address per line.";
    const m = modal(
      `<h3>Send a test</h3><p class="hint">${lead}</p><label for="testTo">Recipients</label><textarea id="testTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="testDefaultsHint" hidden></p><div class="actions"><button type="button" id="tCancel">Cancel</button><button type="button" class="primary" id="tGo">Send test</button></div>`,
    );
    const to = m.el.querySelector("#testTo");
    to.focus();
    // Pre-fill with saved defaults (don't clobber anything already typed).
    api("/api/settings")
      .then((s) => {
        const defaults = s?.settings?.testRecipients || [];
        if (defaults.length && !to.value.trim()) {
          to.value = defaults.join("\n");
          const hint = m.el.querySelector("#testDefaultsHint");
          hint.textContent = "Pre-filled from your default test recipients (Settings).";
          hint.hidden = false;
        }
      })
      .catch(() => {});
    m.el.querySelector("#tCancel").onclick = m.close;
    m.el.querySelector("#tGo").onclick = () =>
      busy(m.el.querySelector("#tGo"), "Sending…", async () => {
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
          let lastWarnings = null;
          for (const addr of addrs) {
            const r = await api(`/posts/${id}/test`, { method: "POST", json: { to: addr } });
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
          toast(e.message);
        }
      });
  };

  // --- schedule (the one send entry point; Send now lives inside as a demoted link) ---
  // Scheduling behind a cancelable review window is the literal default (SPEC §6);
  // sending immediately is the deliberate sub-choice. Both server flows are unchanged
  // (/schedule, /send) — this is one modal with two views, so the safer path is what
  // the Primary opens and the louder one is a step down.
  const scheduleBtn = document.getElementById("scheduleBtn");
  if (scheduleBtn) {
    scheduleBtn.onclick = () => {
      if (!validateSubject()) {
        return; // empty subject: the field-level error is now showing; don't open the modal
      }
      const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
      const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
      const scheduleView =
        `<h3 id="schHead">Schedule this post</h3><p class="hint">It sends at the time you pick (at least 5 minutes out), with a cancelable window until then.</p><label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}">` +
        `<div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>` +
        `<div class="altrow"><span class="altrow-note">Skip the review window?</span><button type="button" class="linkbtn" id="toSendNow">Send now →</button></div>`;
      const m = modal(scheduleView);
      const box = m.el.querySelector(".modal");

      const doSchedule = () =>
        busy(box.querySelector("#schGo"), "Scheduling…", async () => {
          const v = box.querySelector("#schWhen").value;
          const t = v ? new Date(v).getTime() : NaN;
          if (Number.isNaN(t)) {
            toast("Pick a valid date & time");
            return;
          }
          try {
            await saveDraft(true);
            await api(`/posts/${id}/schedule`, {
              method: "POST",
              json: { fire_at: new Date(t).toISOString() },
            });
            m.close();
            // Stay on the post, re-rendered in its scheduled state: the window is the
            // review and this page is the review surface (SPEC §6, DESIGN §7).
            toast(withNoProviderNote(`Scheduled for ${fmt(t)}. Send yourself a test.`));
            renderEditor(id);
          } catch (e) {
            toast(e.message);
          }
        });

      const doSendNow = () =>
        busy(box.querySelector("#snGo"), "Queuing…", async () => {
          try {
            await saveDraft(true);
            await api(`/posts/${id}/send`, { method: "POST" });
            m.close();
            toast(withNoProviderNote("Sends in 5 minutes, cancelable until then."));
            renderEditor(id);
          } catch (e) {
            toast(e.message);
          }
        });

      function wireSchedule() {
        box.setAttribute("aria-labelledby", "schHead");
        box.querySelector("#schCancel").onclick = m.close;
        box.querySelector("#schGo").onclick = doSchedule;
        box.querySelector("#toSendNow").onclick = showSendNow;
        box.querySelector("#schWhen").focus();
      }

      async function showSendNow() {
        box.innerHTML =
          `<h3 id="snHead">Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong id="snWho">your confirmed subscribers</strong> after a 5-minute cancelable window. You can cancel until it fires.</p>` +
          `<div class="altrow altrow-top"><button type="button" class="linkbtn" id="toSchedule">← Back to schedule</button></div>` +
          `<div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`;
        box.setAttribute("aria-labelledby", "snHead");
        box.querySelector("#snCancel").onclick = m.close;
        box.querySelector("#snGo").onclick = doSendNow;
        box.querySelector("#toSchedule").onclick = () => {
          box.innerHTML = scheduleView;
          wireSchedule();
        };
        box.querySelector("#snGo").focus();
        // Fill the real confirmed-subscriber count once known; the copy reads sensibly until then.
        try {
          const s = await api("/subscribers");
          const n = s.counts.confirmed;
          const whoEl = box.querySelector("#snWho");
          if (whoEl) {
            whoEl.textContent = `${n} confirmed subscriber${n === 1 ? "" : "s"}`;
          }
        } catch (_) {}
      }

      wireSchedule();
    };
  }
}
