// @ts-nocheck
// Material Symbols icon paths (viewBox 0 -960 960 960) and the reference room's shared
// shell.

import { buildRefParts } from "./build_ref";
import { esc } from "./helpers";
import { app } from "./shell";
import { appState } from "./state";

const ICONS = {
  heading: "M360-280v-400h80v160h160v-160h80v400h-80v-160H440v160h-80Z",
  bold: "M272-200v-560h221q65 0 120 40t55 111q0 51-23 78.5T602-491q25 11 55.5 41t30.5 90q0 89-65 124.5T501-200H272Zm121-112h104q48 0 58.5-24.5T566-372q0-11-10.5-35.5T494-432H393v120Zm0-228h93q33 0 48-17t15-38q0-24-17-39t-44-15h-95v109Z",
  italic: "M200-200v-100h160l120-360H320v-100h400v100H580L460-300h140v100H200Z",
  quote:
    "m228-240 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T458-480L320-240h-92Zm360 0 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T818-480L680-240h-92ZM362.5-517.5Q380-535 380-560t-17.5-42.5Q345-620 320-620t-42.5 17.5Q260-585 260-560t17.5 42.5Q295-500 320-500t42.5-17.5Zm360 0Q740-535 740-560t-17.5-42.5Q705-620 680-620t-42.5 17.5Q620-585 620-560t17.5 42.5Q655-500 680-500t42.5-17.5ZM680-560Zm-360 0Z",
  code: "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z",
  link: "M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z",
  ul: "M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm-56.5-263.5Q120-687 120-720t23.5-56.5Q167-800 200-800t56.5 23.5Q280-753 280-720t-23.5 56.5Q233-640 200-640t-56.5-23.5Z",
  ol: "M120-80v-60h100v-30h-60v-60h60v-30H120v-60h120q17 0 28.5 11.5T280-280v40q0 17-11.5 28.5T240-200q17 0 28.5 11.5T280-160v40q0 17-11.5 28.5T240-80H120Zm0-280v-110q0-17 11.5-28.5T160-510h60v-30H120v-60h120q17 0 28.5 11.5T280-560v70q0 17-11.5 28.5T240-450h-60v30h100v60H120Zm60-280v-180h-60v-60h120v240h-60Zm180 440v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360Z",
  indent:
    "M120-120v-80h720v80H120Zm320-160v-80h400v80H440Zm0-160v-80h400v80H440Zm0-160v-80h400v80H440ZM120-760v-80h720v80H120Zm0 440v-320l160 160-160 160Z",
  paperclip:
    "M720-330q0 104-73 177T470-80q-104 0-177-73t-73-177v-370q0-75 52.5-127.5T400-880q75 0 127.5 52.5T580-700v350q0 46-32 78t-78 32q-46 0-78-32t-32-78v-370h80v370q0 13 8.5 21.5T470-320q13 0 21.5-8.5T500-350v-350q-1-42-29.5-71T400-800q-42 0-71 29t-29 71v370q-1 71 49 120.5T470-160q70 0 119-49.5T640-330v-390h80v390Z",
  info: "M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
};
export const icon = (name) =>
  `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// The Kestrel falcon mark (the product's own mark), used to identify the reference
// room — distinct from a publication's own logo, which lives in the sidebar brand.
const KESTREL_PATH =
  "M290.028 216.064C285.698 218.264 280.838 219.394 275.978 219.344C281.268 225.044 284.128 232.924 283.708 240.694C283.278 248.844 279.388 256.514 274.268 262.874C269.148 269.244 262.808 274.494 256.608 279.814C237.148 296.474 218.248 314.404 195.328 325.854C178.568 334.224 160.148 338.864 143.458 347.374C140.148 349.064 136.898 350.904 133.418 352.224C129.938 353.544 126.178 354.324 122.498 353.794C121.718 353.684 120.938 353.504 120.228 353.184C119.508 352.864 118.848 352.374 118.408 351.734C117.918 351.024 117.708 350.154 117.718 349.304C117.728 348.454 117.948 347.614 118.268 346.824C118.567 346.054 118.967 345.339 119.371 344.618L119.418 344.534C128.788 327.894 140.118 312.454 150.358 296.344C160.598 280.224 169.848 263.174 174.428 244.634C176.258 237.264 177.328 229.644 176.738 222.074C176.138 214.504 173.808 206.964 169.308 200.854C164.588 194.434 157.728 189.874 150.538 186.434C139.628 181.204 127.768 178.284 115.858 176.154C93.9183 172.224 71.6083 170.884 49.4083 168.944C45.8483 168.634 42.2483 168.294 38.8783 167.124C34.7683 165.704 31.0683 163.004 28.7383 159.334C26.4183 155.664 25.5583 151.024 26.7483 146.844C27.6583 143.624 29.7283 140.784 32.3583 138.724C34.9883 136.654 38.1683 135.324 41.4383 134.634C44.7183 133.944 48.0983 133.874 51.4383 134.154C53.2683 134.304 55.0883 134.554 56.8983 134.824C72.2383 137.094 87.3783 140.484 102.548 143.644C115.468 146.334 128.498 148.864 141.688 149.224C154.878 149.574 168.338 147.654 180.178 141.824C196.548 133.764 208.758 118.514 215.298 101.474C224.258 78.094 223.028 52.174 220.398 27.284C219.788 21.484 219.108 15.614 220.058 9.854C220.178 9.124 220.328 8.38398 220.658 7.71398C220.988 7.05398 221.528 6.45399 222.228 6.19399C222.858 5.95399 223.568 6.01399 224.218 6.22399C224.858 6.43399 225.448 6.77399 226.028 7.12399C262.588 29.154 290.508 63.614 310.198 101.484C312.188 105.314 314.108 109.204 315.408 113.314C316.708 117.434 317.358 121.814 316.768 126.084C316.348 129.114 315.268 132.104 313.318 134.454C310.668 137.634 306.688 139.354 302.778 140.744C298.878 142.124 294.808 143.324 291.488 145.804C286.998 149.174 284.328 154.834 284.598 160.444C292.098 161.904 299.448 164.114 306.508 167.014C312.788 169.594 318.998 172.854 323.418 178.014C327.088 182.294 329.288 187.614 331.438 192.844C332.158 194.584 332.878 196.344 333.328 198.184C333.778 200.014 333.958 201.944 333.578 203.794C333.138 205.934 331.948 207.914 330.248 209.294C329.898 208.024 329.258 206.834 328.408 205.834C326.958 204.154 324.928 203.054 322.798 202.454C318.258 201.174 313.328 202.114 309.018 204.044C304.708 205.974 300.898 208.834 297.068 211.584C294.808 213.204 292.508 214.804 290.028 216.064Z";
const kestrelMark = () =>
  `<svg viewBox="0 0 360 360" aria-hidden="true"><path d="${KESTREL_PATH}"/></svg>`;

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
        <a class="room-brand" href="#/docs">${kestrelMark()}<span>Kestrel</span></a>
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
