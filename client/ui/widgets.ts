// Small shared widgets, each independent of the others: the toast, the status badge, the
// modal, the info tooltip, the row-action menu, the busy state on a button, and the error
// view with its retry. The tooltip's document
// listeners are wired by installTooltips() when boot calls it.

import { toasts } from "../shell";
import { type Html, html, setHtml } from "./html";
import { icon } from "./icons";

// Long enough to read a sentence-length confirmation ("Test sent to 2 addresses").
const TOAST_MS = 3600;
// Matches the .toast.leaving transition in styles.css, so removal trails the collapse.
const TOAST_LEAVE_MS = 300;
// More than this at once is a wall, not a confirmation (DESIGN §5).
const MAX_TOASTS = 3;
const toastTimers = new WeakMap<HTMLElement, number>();

/**
 * A transient confirmation in the app-wide toast region (DESIGN §5). The same message
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

/** A status pill; the status doubles as its class. */
export const badge = (status: string): Html => html`<span class="badge ${status}">${status}</span>`;

export interface Modal {
  el: HTMLElement;
  close: () => void;
  /**
   * Say why the dialog's act didn't go through, inside the dialog: beneath `field` when one
   * field is at fault (marked invalid, focused, and cleared as soon as it is edited),
   * otherwise just above the actions, where the reader is looking; a toast at the foot of
   * the screen would be far from the field and gone while the dialog stays open. A second
   * call replaces the first.
   */
  error: (message: string, field?: HTMLInputElement | HTMLTextAreaElement) => void;
  /** Take the error away, as a new try begins. */
  clearError: () => void;
}

let fieldErrorSeq = 0;
// The clear function of the error each field shows now, so a second error replaces the first.
const fieldErrors = new WeakMap<HTMLElement, () => void>();

/** The one look of a field or dialog error: an icon and the reason, announced as an alert. */
function errorLine(message: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "field-error";
  line.id = `field-error-${++fieldErrorSeq}`;
  line.setAttribute("role", "alert");
  const ico = document.createElement("span");
  ico.className = "field-error-ico";
  ico.setAttribute("aria-hidden", "true");
  ico.textContent = "!";
  const text = document.createElement("span");
  text.textContent = message;
  line.append(ico, text);
  return line;
}

/**
 * Say why a field's value is refused, beneath the field (DESIGN §5): the field is marked
 * invalid and described by the reason, and both go as soon as the field is edited.
 * Returns the function that takes the error away sooner; a second call on the same
 * field replaces the first.
 */
export function fieldError(
  field: HTMLInputElement | HTMLTextAreaElement,
  message: string,
): () => void {
  fieldErrors.get(field)?.();
  const line = errorLine(message);
  const describedBy = field.getAttribute("aria-describedby");
  field.after(line);
  field.setAttribute("aria-describedby", describedBy ? `${describedBy} ${line.id}` : line.id);
  field.classList.add("is-invalid");
  let cleared = false;
  const clear = () => {
    if (cleared) {
      return;
    }
    cleared = true;
    line.remove();
    field.classList.remove("is-invalid");
    if (describedBy === null) {
      field.removeAttribute("aria-describedby");
    } else {
      field.setAttribute("aria-describedby", describedBy);
    }
    field.removeEventListener("input", clear);
    fieldErrors.delete(field);
  };
  field.addEventListener("input", clear);
  fieldErrors.set(field, clear);
  return clear;
}

/**
 * A modal over a backdrop; a click outside or Escape closes it. The content is markup.
 * The dialog belongs to the view that opened it: `signal` is that view's mount signal, and
 * when it aborts (a navigation, a remount) the dialog closes with it, so it never sits over
 * a page it does not belong to. Only the dialog goes: a write already started from it does
 * not take the signal (no write does) and still lands, its answer arriving after the
 * dialog is gone.
 */
export function modal(content: Html, signal: AbortSignal): Modal {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  setHtml(back, html`<div class="modal" role="dialog" aria-modal="true">${content}</div>`);
  const dialog = back.firstElementChild as HTMLElement;
  // Focus goes back where it was when the dialog closes, so a keyboard reader carries on
  // from the control that opened it rather than from the top of the page.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Escape and Tab listen on the document and the end of the view on its signal, so
  // close() takes both listeners with it however the dialog closes (a button, the
  // backdrop, Escape, the view ending), and each lives exactly as long as the dialog.
  const onKey = (e: KeyboardEvent) => {
    // With dialogs stacked (a confirmation over the dialog that asked for it), only the top
    // one answers the keyboard: Escape closes it alone, and Tab stays inside it.
    if (back !== [...document.querySelectorAll(".modal-backdrop")].pop()) {
      return;
    }
    if (e.key === "Escape") {
      close();
    } else if (e.key === "Tab") {
      trapTab(dialog, e);
    }
  };
  // One error at a time: a field's (from fieldError) or the dialog's own line.
  let clearCurrent: (() => void) | null = null;
  const clearError = () => {
    clearCurrent?.();
    clearCurrent = null;
  };
  const error = (message: string, field?: HTMLInputElement | HTMLTextAreaElement) => {
    clearError();
    if (field) {
      clearCurrent = fieldError(field, message);
      field.focus();
      return;
    }
    const line = errorLine(message);
    line.classList.add("dialog-error");
    const actions = dialog.querySelector(".actions");
    if (actions) {
      actions.before(line);
    } else {
      dialog.append(line);
    }
    clearCurrent = () => line.remove();
  };
  const close = () => {
    // A click on the backdrop has already dropped focus to the page body, so that counts as
    // focus lost with the dialog too.
    const active = document.activeElement;
    const hadFocus = back.contains(active) || !active || active === document.body;
    back.remove();
    document.removeEventListener("keydown", onKey);
    signal.removeEventListener("abort", close);
    if (hadFocus && opener?.isConnected) {
      opener.focus();
    }
  };
  if (signal.aborted) {
    // The view is already gone, so the dialog is never shown.
    return { el: back, close, error, clearError };
  }
  document.body.appendChild(back);
  back.addEventListener("click", (e) => {
    if (e.target === back) {
      close();
    }
  });
  document.addEventListener("keydown", onKey);
  signal.addEventListener("abort", close, { once: true });
  // A caller that focuses a field of its own does so before this runs; otherwise focus
  // lands on the dialog's first control, so the keyboard starts inside it.
  queueMicrotask(() => {
    if (back.isConnected && !dialog.contains(document.activeElement)) {
      focusables(dialog)[0]?.focus();
    }
  });
  return { el: back, close, error, clearError };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
}
// Tab and Shift+Tab cycle within the dialog: aria-modal says the page behind is inert, so
// focus must not walk out to it.
function trapTab(dialog: HTMLElement, e: KeyboardEvent): void {
  const els = focusables(dialog);
  const first = els[0];
  const last = els[els.length - 1];
  if (!first || !last) {
    e.preventDefault();
    return;
  }
  const at = document.activeElement;
  if (!dialog.contains(at)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && at === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
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
  /** A line under the label saying what the pick does, for a menu whose items need it. */
  description?: string;
  danger?: boolean;
  onClick: () => void;
}

/** Where a menu sits under its trigger: `end` lines up right edges (a row's ⋯), `start` left edges (a labeled button). */
export interface MenuOptions {
  align?: "start" | "end";
}

// popover menu, for row actions (⋯) and labeled menu buttons. A transparent full-screen overlay (behind
// the menu) closes it on an outside click — no document-listener race.
let menuEls: HTMLElement[] = [];
let menuSignal: AbortSignal | null = null;
let menuAnchor: HTMLElement | null = null;
function closeMenu(): void {
  const hadFocus = menuEls.some((e) => e.contains(document.activeElement));
  for (const e of menuEls) {
    e.remove();
  }
  menuEls = [];
  menuSignal?.removeEventListener("abort", closeMenu);
  menuSignal = null;
  menuAnchor?.setAttribute("aria-expanded", "false");
  // Back to the ⋯ that opened it, so the keyboard keeps its place in the list. A pick that
  // opens a dialog runs after this, and the dialog returns focus here when it closes.
  if (hadFocus && menuAnchor?.isConnected) {
    menuAnchor.focus();
  }
  menuAnchor = null;
}
/**
 * Open a menu under an anchor (a row's ⋯ or a labeled button); any outside click or a pick closes it. Like a
 * modal, it belongs to the view that opened it and closes when `signal`, that view's
 * mount signal, aborts.
 */
export function openMenu(
  anchor: Element,
  items: MenuItem[],
  signal: AbortSignal,
  { align = "end" }: MenuOptions = {},
): void {
  closeMenu();
  if (signal.aborted) {
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.onclick = closeMenu;
  const m = document.createElement("div");
  m.className = "menu";
  m.setAttribute("role", "menu");
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.className = `menu-item${it.danger ? " danger-item" : ""}`;
    if (it.description) {
      const name = document.createElement("span");
      name.className = "menu-item-name";
      name.textContent = it.label;
      const desc = document.createElement("span");
      desc.className = "menu-item-desc";
      desc.textContent = it.description;
      b.append(name, desc);
      m.classList.add("menu-described");
    } else {
      b.textContent = it.label;
    }
    b.onclick = () => {
      closeMenu();
      it.onClick();
    };
    m.appendChild(b);
  }
  m.addEventListener("keydown", (e) => menuKey(m, e));
  document.body.appendChild(overlay);
  document.body.appendChild(m);
  menuEls = [overlay, m];
  menuSignal = signal;
  menuAnchor = anchor instanceof HTMLElement ? anchor : null;
  menuAnchor?.setAttribute("aria-expanded", "true");
  signal.addEventListener("abort", closeMenu, { once: true });
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${(align === "start" ? r.left : r.right - m.offsetWidth) + window.scrollX}px`;
  m.querySelector<HTMLElement>(".menu-item")?.focus();
}
// The menu keys: arrows, Home, and End move between items (wrapping), Escape closes it,
// and Tab closes it and lets focus move on from the ⋯, as a menu button does.
function menuKey(m: HTMLElement, e: KeyboardEvent): void {
  const items = [...m.querySelectorAll<HTMLElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown") {
    go(i + 1);
  } else if (e.key === "ArrowUp") {
    go(i - 1);
  } else if (e.key === "Home") {
    go(0);
  } else if (e.key === "End") {
    go(items.length - 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "Tab") {
    closeMenu();
  }
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
