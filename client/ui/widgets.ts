// Small shared widgets, each independent of the others: the toast, the clipboard copy
// with its toast, the status badge, the modal, the info tooltip, the row-action menu, the
// busy state on a button, and the error view with its retry. The tooltip's document
// listeners are wired by installTooltips() when boot calls it.

import { toasts } from "../shell";
import { type Html, html, setHtml } from "./html";
import { icon } from "./icons";

// Long enough to read a sentence-length confirmation ("Test sent to 2 addresses").
const TOAST_MS = 3600;
// Matches the .toast.leaving transition in styles.css, so removal trails the collapse.
const TOAST_LEAVE_MS = 300;
// More than this at once is a wall, not a confirmation (DESIGN §2).
const MAX_TOASTS = 3;
const toastTimers = new WeakMap<HTMLElement, number>();

/**
 * A transient confirmation in the app-wide toast region (DESIGN §2). The same message
 * already showing has its time restarted rather than a second copy stacked beneath it,
 * and past MAX_TOASTS the oldest leaves early, so a burst never builds a tower.
 */
export function toast(msg: string): void {
  const live = [...toasts.querySelectorAll<HTMLElement>(".toast:not(.leaving)")];
  const same = live.find((t) => t.textContent === msg);
  if (same) {
    lingerToast(same);
    return;
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  lingerToast(t);
  for (const old of live.slice(0, live.length + 1 - MAX_TOASTS)) {
    leaveToast(old);
  }
}

function lingerToast(t: HTMLElement): void {
  clearTimeout(toastTimers.get(t));
  toastTimers.set(
    t,
    window.setTimeout(() => leaveToast(t), TOAST_MS),
  );
}

// Fade and collapse the toast's height together, so the ones beside it slide into its
// place rather than jump. The height is pinned and committed first because a transition
// can't start from auto.
function leaveToast(t: HTMLElement): void {
  clearTimeout(toastTimers.get(t));
  t.style.height = `${t.offsetHeight}px`;
  void t.offsetHeight;
  t.classList.add("leaving");
  t.style.height = "0";
  setTimeout(() => t.remove(), TOAST_LEAVE_MS);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy to clipboard");
  }
}

/** A status pill; the status doubles as its class. */
export const badge = (status: string): Html => html`<span class="badge ${status}">${status}</span>`;

export interface Modal {
  el: HTMLElement;
  close: () => void;
}

/** A modal over a backdrop; a click outside or Escape closes it. The content is markup. */
export function modal(content: Html): Modal {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  setHtml(back, html`<div class="modal" role="dialog" aria-modal="true">${content}</div>`);
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    if (e.target === back) {
      close();
    }
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });
  return { el: back, close };
}

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
