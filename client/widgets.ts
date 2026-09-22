// Small shared widgets, each independent of the others: the info tooltip, the row-action
// menu, the busy state on a button, and the error view with its retry. The tooltip's
// document listeners are wired by installTooltips() when boot calls it.

import { type Html, html, setHtml } from "./html";
import { icon } from "./icons";

// Keep an info tooltip within the viewport. The tip is a CSS pseudo-element
// anchored to the icon's left edge; pure CSS can't see the viewport, so before it
// shows we measure the icon and, if the (width-capped) tip would run off the right
// edge on a narrow screen, slide it left via --tip-x. Delegated so it survives view
// re-renders; with JS off the tip falls back to left:0. Vertical placement stays in
// CSS (the .tip-below variant) — which icons sit near the top is static, not dynamic.
const TIP_GUTTER = 8;
function positionInfoTip(el: HTMLElement): void {
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
/** Wire the tooltip's positioning and dismissal, delegated on the document; boot calls this once. */
export function installTooltips(): void {
  // Position before the tip shows on either trigger: pointer hover, or focus — the
  // latter is how keyboard (Tab) and touch (tap focuses the span) reach it.
  for (const type of ["pointerover", "focusin"]) {
    document.addEventListener(type, (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(".info") : null;
      if (el) {
        positionInfoTip(el);
      }
    });
  }
  // Escape dismisses a focus-shown tip without tabbing away (the pointer tip just
  // needs the mouse to leave).
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (e.key === "Escape" && active instanceof HTMLElement && active.classList.contains("info")) {
      active.blur();
    }
  });
}

/**
 * The ⓘ affordance whose explanation shows as a tooltip. Focusable and role/aria-labelled
 * so it's reachable by keyboard and touch (the tip shows on :focus, not only :hover) and
 * read by screen readers — the aria-label mirrors the visible tip. `below` drops the tip
 * under the icon (for icons near the page top).
 */
export function infoTip(tip: string, { below = false }: { below?: boolean } = {}): Html {
  return html`<span class="info${below ? " tip-below" : ""}" role="img" tabindex="0" aria-label="${tip}" data-tip="${tip}">${icon("info-filled")}</span>`;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

// popover menu for row actions (⋯). A transparent full-screen overlay (behind
// the menu) closes it on an outside click — no document-listener race.
let menuEls: HTMLElement[] = [];
function closeMenu(): void {
  for (const e of menuEls) {
    e.remove();
  }
  menuEls = [];
}
/** Open a row-action menu under an anchor; any outside click or a pick closes it. */
export function openMenu(anchor: Element, items: MenuItem[]): void {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.onclick = closeMenu;
  const m = document.createElement("div");
  m.className = "menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `menu-item${it.danger ? " danger-item" : ""}`;
    b.textContent = it.label;
    b.onclick = () => {
      closeMenu();
      it.onClick();
    };
    m.appendChild(b);
  }
  document.body.appendChild(overlay);
  document.body.appendChild(m);
  menuEls = [overlay, m];
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${r.right + window.scrollX - m.offsetWidth}px`;
}

/** Run an action with the button disabled and relabeled, restoring it after, if it is still in the page. */
export async function busy<T>(
  btn: HTMLButtonElement,
  label: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = btn.textContent;
  btn.disabled = true;
  if (label) {
    btn.textContent = label;
  }
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}

/** The error view with a retry, in place of what failed to load. */
export function renderError(container: Element, msg: string, retryFn: () => void): void {
  setHtml(
    container,
    html`<div class="error"><span>${msg}</span><button class="ghost" data-retry>Retry</button></div>`,
  );
  const b = container.querySelector<HTMLButtonElement>("[data-retry]");
  if (b) {
    b.onclick = retryFn;
  }
}
