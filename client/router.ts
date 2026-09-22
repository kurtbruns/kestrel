// The hash router: route() tears the previous view down (timers, editor guards) and
// mounts the next; the leave guards live here.

import { savebar, stopPollers } from "./savebar";
import { setNavOpen } from "./shell";
import { appState } from "./state";
import { renderDashboard } from "./views/dashboard";
import { renderDocs } from "./views/docs";
import { renderDrafts } from "./views/drafts";
import { clearAutosaveTimers, LEAVE_MSG, renderEditor } from "./views/editor";
import { renderReference } from "./views/reference";
import { renderSent } from "./views/sends";
import { renderSentRecord } from "./views/sent";
import { renderSettings } from "./views/settings";
import { renderSubscribers } from "./views/subscribers";
import { renderTemplate } from "./views/template";

/** Mount the view the hash names, tearing the previous one down first. */
export function route(): unknown {
  stopPollers();
  clearAutosaveTimers();
  appState.isEditorDirty = false;
  appState.editorSaveFailed = false;
  appState.editorConflict = false;
  appState.editorHash = null; // renderEditor re-establishes these when it mounts
  appState.editorLeaveFlush = null;
  appState.editorManualSave = null;
  savebar.detach(); // the mounting page re-attaches if it uses the shared save bar
  const hash = location.hash || "#/dashboard";
  const [, view, arg] = hash.split("/");
  // The editor wants the full width, and carries its own "← Posts" affordance, so
  // it hides the sidebar rather than living beside it (SPEC §11: admin-only chrome).
  document.body.classList.toggle("editor-mode", view === "edit");
  // The reference room (Docs, API) is about Kestrel itself, not the publication, so it
  // drops the publication sidebar for a slim tool bar.
  const toolMode = view === "docs" || view === "reference";
  document.body.classList.toggle("tool-mode", toolMode);
  // Mark the active nav item across both sidebar navs (primary + tools) so the
  // reader can see where they are (aria-current also styles it).
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".sidebar a[data-view]")) {
    if (a.dataset.view === view) {
      a.setAttribute("aria-current", "page");
    } else {
      a.removeAttribute("aria-current");
    }
  }
  // The reference room's surface switch is marked at render time (roomShell). Close
  // the mobile nav drawer on any navigation.
  setNavOpen(false);
  if (view === "edit" && arg) {
    return renderEditor(arg);
  }
  if (view === "drafts") {
    return renderDrafts();
  }
  if (view === "subscribers") {
    return renderSubscribers(arg);
  }
  if (view === "sent") {
    return arg ? renderSentRecord(arg) : renderSent();
  }
  if (view === "template") {
    return renderTemplate();
  }
  if (view === "settings") {
    return renderSettings();
  }
  if (view === "reference") {
    return renderReference();
  }
  if (view === "docs") {
    return renderDocs(arg);
  }
  return renderDashboard();
}
// Navigating away from a dirty editor saves in the background rather than
// prompting — hashchange fires after the hash has already moved, so the flush
// captures the payload before route() tears down the DOM. The exception is when
// the last save FAILED: silently flushing could lose work, so we fall back to a
// confirm() (synchronous, unlike the modal helper) and, on cancel, restore the
// editor's hash and swallow the echo.
let revertingHash = false;
window.addEventListener("hashchange", () => {
  if (revertingHash) {
    revertingHash = false;
    return;
  }
  if (appState.isEditorDirty && appState.editorHash && location.hash !== appState.editorHash) {
    if (appState.editorSaveFailed || appState.editorConflict) {
      // A silent flush would fail (or clobber) — prompt so the user decides.
      if (!confirm(LEAVE_MSG)) {
        revertingHash = true;
        location.hash = appState.editorHash;
        return;
      }
    } else if (appState.editorLeaveFlush) {
      appState.editorLeaveFlush();
    }
  }
  route();
});
// Tab close / reload / external navigation: can't reliably finish an async save,
// so fall back to the browser's own generic unsaved-changes prompt.
window.addEventListener("beforeunload", (e) => {
  if (appState.isEditorDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
// ⌘S / Ctrl-S saves the mounted editor (registered once; no-op elsewhere).
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && appState.editorManualSave) {
    e.preventDefault();
    appState.editorManualSave();
  }
});
