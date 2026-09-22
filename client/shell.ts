// The app shell: the DOM roots every view renders into, and the sidebar's drawer and
// collapse modes, which installShell() wires when boot calls it.

/** A root the page always carries (public/dashboard/index.html); missing means the wrong page. */
function root(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`the admin page has no #${id}`);
  }
  return el;
}

export const app = root("app");
export const identity = root("identity");
export const toasts = root("toasts");

// Mobile nav drawer: the hamburger slides the sidebar in; the scrim or any nav
// click closes it. On desktop the sidebar is always in view and these are inert.
const navToggle = document.getElementById("navToggle");
const navScrim = document.getElementById("navScrim");
export function setNavOpen(open: boolean): void {
  document.body.classList.toggle("nav-open", open);
  navToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (navScrim) {
    navScrim.hidden = !open;
  }
}
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
let navOverride: "collapsed" | "expanded" | null = null;
function computeNavMode(): "full" | "rail" {
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
function applyNavMode(): void {
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
let navResizeRaf = 0;
let navResizeSettle = 0;

/** Wire the drawer, the collapse chevron, and the resize tracking; boot calls this once. */
export function installShell(): void {
  navToggle?.addEventListener("click", () =>
    setNavOpen(!document.body.classList.contains("nav-open")),
  );
  navScrim?.addEventListener("click", () => setNavOpen(false));
  document.querySelector(".sidebar")?.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("a")) {
      setNavOpen(false);
    }
  });
  navCollapse?.addEventListener("click", () => {
    navOverride = document.documentElement.dataset.nav !== "rail" ? "collapsed" : "expanded";
    applyNavMode();
  });
  // Track the responsive default as the window resizes (rAF-coalesced). A session
  // override still wins at 540 and up; below it, the mobile overlay takes over. The
  // nav-resizing class suppresses the sidebar's own transitions for the duration, so a
  // breakpoint cross (rail → mobile drawer) snaps instead of animating a stray slide.
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
}
