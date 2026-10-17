// The hash router: route() mounts the view the hash names, and the mount tears the
// previous one down; the leave guards live here, over the mounted view's handle, wired by
// installRouter() when boot calls it.

import { dashboardRouteFromSearch, isDashboardRoute } from "../shared/dashboard_link";
import { renderDashboard } from "./dashboard/dashboard";
import { mount, mounted } from "./lifecycle";
import { renderDrafts } from "./posts/drafts";
import { renderEditor } from "./posts/editor";
import { renderWebVersion, webPostId } from "./posts/web";
import { renderDocs } from "./room/docs";
import { renderReference } from "./room/reference";
import { renderSent } from "./sends/list";
import { renderSentRecord } from "./sends/record";
import { renderSettings } from "./settings/settings";
import { renderTemplate } from "./settings/template";
import { setNavOpen } from "./shell";
import { renderImport } from "./subscribers/import";
import { renderSubscribers } from "./subscribers/list";

const LEAVE_MSG = "You have unsaved changes. Leave without saving?";

// The hash the mounted view was routed at: a hashchange back to it is nothing to do (the
// echo of a declined leave prompt putting it back), and a declined prompt knows where to go.
let mountedHash = "";

/** Mount the view the hash names; the mount tears the previous one down. */
export function route(): Promise<void> {
  let hash = location.hash || "#/dashboard";
  // The API reference's address was `#/reference`. An old link, a route's included, opens the
  // same place under its new name, the address bar corrected with no history entry added.
  if (hash === "#/reference" || hash.startsWith("#/reference/")) {
    hash = `#/api-reference${hash.slice("#/reference".length)}`;
    history.replaceState(history.state, "", hash);
  }
  mountedHash = hash;
  // Views put a route's segments into API paths as they are, so a hash a link from an email
  // could not name (a `..` segment, say) opens the dashboard home, as a mangled link does.
  const [, view, arg, sub] = (isDashboardRoute(hash.slice(1)) ? hash : "#/dashboard").split("/");
  // The editor wants the full width, and carries its own "← Posts" affordance, so
  // it hides the sidebar rather than living beside it (SPEC §11: admin-only chrome).
  document.body.classList.toggle("editor-mode", view === "edit");
  // A post's web version is a page of its own, in a tab of its own: the whole window, with
  // no app chrome around it. Only for a route that names a post, so a mangled address
  // falls through to the dashboard with its navigation.
  const webPost = view === "web" ? webPostId(arg, sub) : null;
  document.body.classList.toggle("web-mode", webPost !== null);
  // The reference room (Docs, API) is about Kestrel itself, not the publication, so it
  // drops the publication sidebar for a slim tool bar.
  const toolMode = view === "docs" || view === "api-reference";
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
  if (webPost !== null) {
    return mount((root, signal) => renderWebVersion(webPost, root, signal));
  }
  if (view === "drafts") {
    return mount(renderDrafts);
  }
  if (view === "subscribers" && arg === "import") {
    return mount(renderImport);
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
  if (view === "api-reference") {
    return mount((root, signal) => renderReference(root, signal, arg));
  }
  if (view === "docs") {
    return mount((root, signal) => renderDocs(arg, root, signal, sub));
  }
  return mount(renderDashboard);
}

/** Adopt the route a link from an email names in its query (`/dashboard/?to=/sent/<id>`,
 *  shared/dashboard_link.ts), which survives an Access login where a hash would not: it
 *  becomes the hash, the query goes, and no history entry is added. Boot calls this once,
 *  signed in, before the first route(). */
export function adoptLinkedRoute(): void {
  const linked = dashboardRouteFromSearch(location.search);
  if (linked) {
    // Edit this page's own URL, so the result is same-origin whatever its path; the link's
    // route replaces any hash, since it is the page the link was sent to open.
    const url = new URL(location.href);
    url.search = "";
    url.hash = linked;
    history.replaceState(null, "", url);
  }
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
