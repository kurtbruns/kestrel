// @ts-nocheck
// The reference room shell shared by Docs and the API reference: the top bar, the
// contents rail, and the surface switch.

import { buildRefParts } from "./build_ref";
import { esc } from "./helpers";
import { icon } from "./icons";
import { app } from "./shell";
import { appState } from "./state";

// The reference room shell shared by Docs / API: a top bar (a rail-width "← Dashboard",
// the Kestrel mark, the surface switch) over a two-column grid whose left column — the
// contents rail — lines up exactly under "← Dashboard". Pass railHtml = null for a
// surface with no contents rail.
//
// On mobile (≤720px, styles.css) the same markup collapses to one --bar-h row — a square
// back arrow, the mark, the tabs — so the bar never grows past the height the in-page
// anchors and the sticky rail are calibrated for; the ✕ drops there (← is the one way
// back). The body stacks, and each rail decides its own mobile shape (a folded "On this
// page", or a chip row — see the surfaces below).
export function roomShell(active, railHtml, mainHtml) {
  const tab = (view, label) =>
    `<a href="#/${view}" data-room="${view}" data-text="${esc(label)}"${active === view ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  // The running build (SPEC §9) as quiet metadata — version → release, sha → commit —
  // pinned to the rail's bottom-left corner on every surface, so the bar stays identity +
  // nav. On mobile the rail is no longer a column, so the same stamp is the room's foot
  // instead (styles.css shows one or the other). "" until a build is known; the build time
  // rides the tooltip. Build info lives in the app's own room (and at GET /api/version),
  // never in the publisher-facing dashboard.
  const parts = buildRefParts();
  const bt = appState.appConfig?.deployment?.build?.buildTime;
  const built = bt
    ? ` title="Built ${esc(new Date(bt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}"`
    : "";
  const stamp = parts ? `${parts.version} <span aria-hidden="true">·</span> ${parts.sha}` : "";
  const railFoot = stamp ? `<div class="rail-foot"${built}>${stamp}</div>` : "";
  const foot = stamp ? `<footer class="room-foot"${built}>${stamp}</footer>` : "";
  const body =
    railHtml == null
      ? `<div class="room-body norail"><div class="room-main">${mainHtml}</div></div>`
      : `<div class="room-body"><nav class="room-rail" aria-label="Contents"><div class="rail-inner">${railHtml}${railFoot}</div></nav><div class="room-main">${mainHtml}</div></div>`;
  return `<div class="room">
    <header class="room-bar">
      <a class="room-back" href="#/dashboard" aria-label="Back to dashboard"><span aria-hidden="true">←</span><span class="room-back-label">Dashboard</span></a>
      <div class="room-nav">
        <a class="room-brand" href="#/docs">${icon("kestrel")}<span>Kestrel</span></a>
        <nav class="room-switch" aria-label="Reference">${tab("docs", "Docs")}${tab("reference", "API")}</nav>
        <a class="room-close" href="#/dashboard" title="Back to publication" aria-label="Back to publication"><span aria-hidden="true">✕</span></a>
      </div>
    </header>
    ${body}
    ${foot}
  </div>`;
}
// A room-bar link to the page you're already on (the active tab, or the wordmark on the
// docs index) sets the hash to what it already is, so no hashchange fires and nothing
// re-renders or scrolls. Make it the "back to the top" it reads as, so the bar behaves
// the same whether or not the tap happens to change the hash. Instant, like every other
// in-page move here (the "On this page" links) and like a cross-page click landing at
// the top of its page. Delegated once on #app, so it survives every re-render of the room.
app.addEventListener("click", (ev) => {
  const a = ev.target.closest(".room-bar a[href^='#/']");
  if (!a || a.getAttribute("href") !== location.hash) {
    return;
  }
  ev.preventDefault();
  window.scrollTo(0, 0);
});
