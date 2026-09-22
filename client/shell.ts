// @ts-nocheck
// The app shell: the sidebar's drawer and collapse modes, the DOM roots every view
// renders into.

export const app = document.getElementById("app");
export const identity = document.getElementById("identity");
export const toasts = document.getElementById("toasts");

// Mobile nav drawer: the hamburger slides the sidebar in; the scrim or any nav
// click closes it. On desktop the sidebar is always in view and these are inert.
const navToggle = document.getElementById("navToggle");
const navScrim = document.getElementById("navScrim");
export function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  navToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (navScrim) {
    navScrim.hidden = !open;
  }
}
navToggle?.addEventListener("click", () =>
  setNavOpen(!document.body.classList.contains("nav-open")),
);
navScrim?.addEventListener("click", () => setNavOpen(false));
document.querySelector(".sidebar")?.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    setNavOpen(false);
  }
});

// Collapsible sidebar. The effective width mode lives in data-nav on <html> ("full"
// vs "rail"); CSS keys off it. By default the mode follows the viewport width (the
// <head> guard in index.html sets it before first paint). The footer chevron toggles a
// manual override, but that override is deliberately session-only — held in memory, not
// stored — so a plain reload always drops back to the width-based default. That gives a
// one-keystroke way back to "auto" and avoids a saved preference getting stuck fighting
// the width across sizes. The chevron is hidden below 540, where the sidebar is an
// off-canvas overlay driven by the hamburger instead.
const navCollapse = document.getElementById("navCollapse");
// null = follow the width; "collapsed" / "expanded" = manual override for this load.
let navOverride = null;
function computeNavMode() {
  if (window.innerWidth < 540) {
    return "full";
  }
  if (navOverride === "collapsed") {
    return "rail";
  }
  if (navOverride === "expanded") {
    return "full";
  }
  return window.innerWidth <= 1024 ? "rail" : "full";
}
function applyNavMode() {
  const mode = computeNavMode();
  document.documentElement.dataset.nav = mode;
  if (!navCollapse) {
    return;
  }
  const expanded = mode !== "rail";
  const label = expanded ? "Collapse sidebar" : "Expand sidebar";
  navCollapse.setAttribute("aria-expanded", expanded ? "true" : "false");
  navCollapse.setAttribute("aria-label", label);
  navCollapse.setAttribute("title", label);
}
navCollapse?.addEventListener("click", () => {
  navOverride = document.documentElement.dataset.nav !== "rail" ? "collapsed" : "expanded";
  applyNavMode();
});
// Track the responsive default as the window resizes (rAF-coalesced). A session
// override still wins at 540 and up; below it, the mobile overlay takes over. The
// nav-resizing class suppresses the sidebar's own transitions for the duration, so a
// breakpoint cross (rail → mobile drawer) snaps instead of animating a stray slide.
let navResizeRaf = 0;
let navResizeSettle = 0;
window.addEventListener("resize", () => {
  document.body.classList.add("nav-resizing");
  clearTimeout(navResizeSettle);
  navResizeSettle = setTimeout(() => {
    document.body.classList.remove("nav-resizing");
  }, 200);
  if (navResizeRaf) {
    return;
  }
  navResizeRaf = requestAnimationFrame(() => {
    navResizeRaf = 0;
    applyNavMode();
  });
});
applyNavMode();
