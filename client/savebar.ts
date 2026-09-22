// @ts-nocheck
// The shared unsaved-changes bar, info tips, menus, and the poller teardown route()
// runs on every navigation.

import { esc } from "./helpers";
import { icon } from "./icons";
import { busy } from "./notice";
import { appState } from "./state";

// One full-width banner fixed to the bottom of the viewport (markup in index.html),
// shared by every surface with an explicit save + a revertible baseline: Settings
// and the Template page. A page attaches once on mount, then drives it — setDirty()
// slides it up while there are unsaved changes, showError() keeps it up after a
// rejected save and says why (right beside Save). route() detaches it on every
// navigation, so a page owns the bar only while it's mounted. The post editor keeps
// its own autosave + conflict model (see renderEditor) and deliberately does not use
// this — a "Save / Discard against a baseline" bar doesn't fit continuous autosave.
export const savebar = (() => {
  const el = document.getElementById("savebar");
  const msgEl = el.querySelector(".savebar-msg");
  const saveBtn = document.getElementById("savebarSave");
  const discardBtn = document.getElementById("savebarDiscard");
  // Bumped on every attach/detach so a stale async handler (a save that resolves
  // after the user navigated away) can never drive a bar a new page now owns.
  let token = 0;

  const setMsg = (text) => {
    msgEl.innerHTML = `<span class="savebar-dot"></span><span></span>`;
    msgEl.lastChild.textContent = text;
  };
  const reveal = () => {
    el.hidden = false;
    // Arm the slide-up: un-hide, then force a reflow so the off-screen base transform
    // is the established start state before .show flips it (a hidden → .show toggle in
    // one tick wouldn't transition). A synchronous reflow works even when the tab is
    // backgrounded and requestAnimationFrame is paused.
    void el.offsetHeight;
    el.classList.add("show");
  };

  function detach() {
    token++;
    el.classList.remove("show", "is-error");
    el.hidden = true;
    saveBtn.onclick = null;
    discardBtn.onclick = null;
    // Drop the bottom padding the page reserved for the (fixed) bar.
    document.body.classList.remove("has-savebar");
  }

  // Mount the bar for the current page; returns the handle the page drives. onSave
  // runs inside busy() on the shared Save button, so the page's callback is a plain
  // async function (it should call handle.setDirty(false) on success, or
  // handle.showError(msg) on a rejected save).
  function attach({ onSave, onDiscard, saveLabel = "Save changes", discardLabel = "Discard" }) {
    const mine = ++token;
    saveBtn.textContent = saveLabel;
    discardBtn.textContent = discardLabel;
    el.classList.remove("show", "is-error");
    setMsg("You have unsaved changes.");
    el.hidden = true; // revealed on the first setDirty(true) / showError()
    // Reserve bottom room on the content for the whole time this page is mounted, so
    // the last section never slides under the fixed bar (no shift as it toggles).
    document.body.classList.add("has-savebar");
    saveBtn.onclick = () => busy(saveBtn, "Saving…", () => Promise.resolve(onSave()));
    discardBtn.onclick = () => onDiscard();
    const alive = () => token === mine;
    return {
      setDirty(dirty) {
        if (!alive()) {
          return;
        }
        el.classList.remove("is-error");
        if (dirty) {
          setMsg("You have unsaved changes.");
          reveal();
        } else {
          el.classList.remove("show");
        }
      },
      showError(text) {
        if (!alive()) {
          return;
        }
        el.classList.add("is-error");
        setMsg(text);
        reveal();
      },
    };
  }

  return { attach, detach };
})();

// Keep an info tooltip within the viewport. The tip is a CSS pseudo-element
// anchored to the icon's left edge; pure CSS can't see the viewport, so before it
// shows we measure the icon and, if the (width-capped) tip would run off the right
// edge on a narrow screen, slide it left via --tip-x. Delegated so it survives view
// re-renders; with JS off the tip falls back to left:0. Vertical placement stays in
// CSS (the .tip-below variant) — which icons sit near the top is static, not dynamic.
const TIP_GUTTER = 8;
function positionInfoTip(el) {
  // Measure the rendered tip (laid out even while hidden) so this stays in step
  // with the CSS max-width/padding rather than duplicating them here.
  const tip = getComputedStyle(el, "::after");
  const tipW = parseFloat(tip.width) + parseFloat(tip.paddingLeft) + parseFloat(tip.paddingRight);
  if (!Number.isFinite(tipW)) {
    return;
  }
  const iconLeft = el.getBoundingClientRect().left;
  const vw = document.documentElement.clientWidth;
  // Slide left enough to clear the right gutter, but never so far that the left
  // edge crosses the gutter (very narrow screens) and never rightward (shift ≤ 0).
  const shift = Math.min(0, Math.max(vw - TIP_GUTTER - tipW - iconLeft, TIP_GUTTER - iconLeft));
  el.style.setProperty("--tip-x", `${Math.round(shift)}px`);
}
// Position before the tip shows on either trigger: pointer hover, or focus — the
// latter is how keyboard (Tab) and touch (tap focuses the span) reach it.
for (const type of ["pointerover", "focusin"]) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest?.(".info");
    if (el) {
      positionInfoTip(el);
    }
  });
}
// Escape dismisses a focus-shown tip without tabbing away (the pointer tip just
// needs the mouse to leave).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement?.classList.contains("info")) {
    document.activeElement.blur();
  }
});

// The ⓘ affordance whose explanation shows as a tooltip. Focusable and
// role/aria-labelled so it's reachable by keyboard and touch (the tip shows on
// :focus, not only :hover) and read by screen readers — the aria-label mirrors the
// visible tip. `below` drops the tip under the icon (for icons near the page top).
export function infoTip(tip, { below = false } = {}) {
  const t = esc(tip);
  return `<span class="info${below ? " tip-below" : ""}" role="img" tabindex="0" aria-label="${t}" data-tip="${t}">${icon("info-filled")}</span>`;
}

// popover menu for row actions (⋯). A transparent full-screen overlay (behind
// the menu) closes it on an outside click — no document-listener race.
let menuEls = [];
function closeMenu() {
  menuEls.forEach((e) => {
    e.remove();
  });
  menuEls = [];
}
export function openMenu(anchor, items) {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.onclick = closeMenu;
  const m = document.createElement("div");
  m.className = "menu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `menu-item${it.danger ? " danger-item" : ""}`;
    b.textContent = it.label;
    b.onclick = () => {
      closeMenu();
      it.onClick();
    };
    m.appendChild(b);
  });
  document.body.appendChild(overlay);
  document.body.appendChild(m);
  menuEls = [overlay, m];
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${r.right + window.scrollX - m.offsetWidth}px`;
}

// Stop every background poller and invalidate any poll whose fetch is already in flight.
// Shared by route() (on every navigation) and showReauth() — a walled tab must go quiet
// instead of hammering the API on a dead token every few seconds. Clearing a timer only
// stops the pending tick, not a poll already mid-await, so bumping navGeneration makes that
// callback bail instead of rescheduling (see navGeneration).
export function stopPollers() {
  if (appState.statusTimer) {
    clearInterval(appState.statusTimer);
    appState.statusTimer = null;
  }
  if (appState.editorPollTimer) {
    clearInterval(appState.editorPollTimer);
    appState.editorPollTimer = null;
  }
  if (appState.progressTimer) {
    clearInterval(appState.progressTimer);
    appState.progressTimer = null;
  }
  appState.navGeneration++;
}
