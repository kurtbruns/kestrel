// The reference room shell shared by Docs and the API reference: the top bar, the
// contents rail, and the surface switch.

import { buildRefParts } from "./build_ref";
import { type Html, html } from "./html";
import { icon } from "./icons";
import { app } from "./shell";
import { appState } from "./state";

/** The two surfaces the room switches between. */
export type RoomSurface = "docs" | "reference";

/**
 * The reference room shell shared by Docs / API: a top bar (a rail-width "← Dashboard",
 * the Kestrel mark, the surface switch) over a two-column grid whose left column, the
 * contents rail, lines up exactly under "← Dashboard". Pass rail = null for a surface
 * with no contents rail.
 *
 * On mobile (≤720px, styles.css) the same markup collapses to one --bar-h row (a square
 * back arrow, the mark, the tabs) so the bar never grows past the height the in-page
 * anchors and the sticky rail are calibrated for; the ✕ drops there (← is the one way
 * back). The body stacks, and each rail decides its own mobile shape (a folded "On this
 * page", or a chip row; see the surfaces).
 */
export function roomShell(active: RoomSurface, rail: Html | null, main: Html): Html {
  const tab = (view: RoomSurface, label: string) =>
    active === view
      ? html`<a href="#/${view}" data-room="${view}" data-text="${label}" aria-current="page">${label}</a>`
      : html`<a href="#/${view}" data-room="${view}" data-text="${label}">${label}</a>`;
  // The running build (SPEC §9) as quiet metadata (version → release, sha → commit),
  // pinned to the rail's bottom-left corner on every surface, so the bar stays identity +
  // nav. On mobile the rail is no longer a column, so the same stamp is the room's foot
  // instead (styles.css shows one or the other). Nothing until a build is known; the build
  // time rides the tooltip. Build info lives in the app's own room (and at GET
  // /api/version), never in the publisher-facing dashboard.
  const parts = buildRefParts();
  const bt = appState.appConfig?.deployment.build.buildTime;
  const built = bt
    ? `Built ${new Date(bt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    : null;
  const stamp = parts
    ? html`${parts.version} <span aria-hidden="true">·</span> ${parts.sha}`
    : null;
  const railFoot = stamp
    ? built
      ? html`<div class="rail-foot" title="${built}">${stamp}</div>`
      : html`<div class="rail-foot">${stamp}</div>`
    : null;
  const foot = stamp
    ? built
      ? html`<footer class="room-foot" title="${built}">${stamp}</footer>`
      : html`<footer class="room-foot">${stamp}</footer>`
    : null;
  const body =
    rail == null
      ? html`<div class="room-body norail"><div class="room-main">${main}</div></div>`
      : html`<div class="room-body"><nav class="room-rail" aria-label="Contents"><div class="rail-inner">${rail}${railFoot}</div></nav><div class="room-main">${main}</div></div>`;
  return html`<div class="room">
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
  const a = ev.target instanceof Element ? ev.target.closest(".room-bar a[href^='#/']") : null;
  if (!a || a.getAttribute("href") !== location.hash) {
    return;
  }
  ev.preventDefault();
  window.scrollTo(0, 0);
});
