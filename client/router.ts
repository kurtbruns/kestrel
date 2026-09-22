// The hash router: route() mounts the view the hash names, and the mount tears the
// previous one down; the leave guards live here, over the mounted view's handle, wired by
// installRouter() when boot calls it.

import { renderDashboard } from "./dashboard/dashboard";
import { mount, mounted } from "./lifecycle";
import { renderDrafts } from "./posts/drafts";
import { renderEditor } from "./posts/editor";
import { renderDocs } from "./room/docs";
import { renderReference } from "./room/reference";
import { renderSent } from "./sends/list";
import { renderSentRecord } from "./sends/record";
import { renderSettings } from "./settings/settings";
import { renderTemplate } from "./settings/template";
import { setNavOpen } from "./shell";
import { renderSubscribers } from "./subscribers/list";

const LEAVE_MSG = "You have unsaved changes. Leave without saving?";

// The hash the mounted view was routed at: a hashchange back to it is nothing to do (the
// echo of a declined leave prompt putting it back), and a declined prompt knows where to go.
let mountedHash = "";

/** Mount the view the hash names; the mount tears the previous one down. */
export function route(): Promise<void> {
  const hash = location.hash || "#/dashboard";
  mountedHash = hash;
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
    return mount((root, signal) => renderEditor(arg, root, signal));
  }
  if (view === "drafts") {
    return mount(renderDrafts);
  }
  if (view === "subscribers") {
    return mount((root, signal) => renderSubscribers(arg, root, signal));
  }
  if (view === "sent") {
    return arg ? mount((root, signal) => renderSentRecord(arg, root, signal)) : mount(renderSent);
  }
  if (view === "template") {
    return mount(renderTemplate);
  }
  if (view === "settings") {
    return mount(renderSettings);
  }
  if (view === "reference") {
    return mount(renderReference);
  }
  if (view === "docs") {
    return mount((root, signal) => renderDocs(arg, root, signal));
  }
  return mount(renderDashboard);
}
/** Wire navigation and the mounted view's guards: hashchange, the unload prompt, and ⌘S. Boot calls this once. */
export function installRouter(): void {
  // hashchange fires after the hash has already moved, so the mounted view is asked
  // before route() tears it down: a dirty editor saves in the background and lets the
  // navigation through, unless its last save failed (a silent flush could lose work),
  // when it asks for a confirm() (synchronous, unlike the modal helper) and, on cancel,
  // the hash goes back, which is a hashchange to the mounted hash and so nothing to do.
  window.addEventListener("hashchange", () => {
    if (location.hash === mountedHash) {
      return;
    }
    if (mounted()?.beforeLeave?.() === "confirm" && !confirm(LEAVE_MSG)) {
      location.hash = mountedHash;
      return;
    }
    route();
  });
  // Tab close / reload / external navigation: can't reliably finish an async save,
  // so fall back to the browser's own generic unsaved-changes prompt.
  window.addEventListener("beforeunload", (e) => {
    if (mounted()?.dirty?.()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // ⌘S / Ctrl-S saves the mounted view, when it saves (registered once; no-op elsewhere).
  window.addEventListener("keydown", (e) => {
    const save = mounted()?.manualSave;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && save) {
      e.preventDefault();
      save();
    }
  });
}
