// The dismissible notice (DESIGN §2), the busy state, and the error view.

import { type Html, html, setHtml } from "./html";
import { icon } from "./icons";

// An event, with a time, that the reader could not otherwise know happened: shown once
// per event, cleared by the reader, asking nothing. Never a tip, a standing state (the
// banner's), a warning (the health block's), or a nag. `notice(slot, {...})` renders one
// into a surface's notice slot and owns both the dismiss control and the record of what
// was dismissed, so a surface never touches either.
//
// Identity is the (kind, subject, version) triple, e.g. ("applied", a send id, its
// remade_at): clearing records it, and a newer version of the same subject shows again
// on its own. An aggregate over several subjects passes `members: [{ subject, version }]`
// instead of one subject; dismissing it records every member and it is hidden once every
// member is, so clearing it on one surface clears the members everywhere.
//
// The record is per browser: one localStorage key holding one JSON map from
// `kind|subject` to { v: version, t: dismissed-at }, capped (oldest dismissal dropped)
// so it never grows without bound. Every read and write is guarded, so a browser that
// blocks storage simply shows the notice each time. A convenience, safe to lose, like
// the template editor's line-number toggle: the fact itself always lives in the API.
// Server-side "seen" state (per principal) is deliberately not this.
const NOTICE_KEY = "kestrel.notices";
const NOTICE_CAP = 100;

type Dismissed = Record<string, { v: string; t: number }>;

function readDismissed(): Dismissed {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTICE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Dismissed)
      : {};
  } catch {
    return {};
  }
}
function writeDismissed(map: Dismissed): void {
  try {
    localStorage.setItem(NOTICE_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked or full: the notice simply shows again next time */
  }
}

/** One subject a notice is about, at the version of the event. */
export interface NoticeMember {
  subject: string;
  version: string | number;
}

export interface NoticeSpec {
  kind: string;
  subject?: string;
  version?: string | number;
  /** An aggregate over several subjects, instead of one `subject` + `version`. */
  members?: NoticeMember[];
  markup: Html;
}

const noticeMemberKey = (kind: string, subject: string) => `${kind}|${subject}`;
function recordDismissed(kind: string, members: NoticeMember[]): void {
  const map = readDismissed();
  const now = Date.now();
  for (const { subject, version } of members) {
    map[noticeMemberKey(kind, subject)] = { v: String(version), t: now };
  }
  const keys = Object.keys(map);
  if (keys.length > NOTICE_CAP) {
    keys.sort((a, b) => (map[a]?.t || 0) - (map[b]?.t || 0));
    for (const k of keys.slice(0, keys.length - NOTICE_CAP)) {
      delete map[k];
    }
  }
  writeDismissed(map);
}

/**
 * Render a notice into a slot. Returns the element, or null when every member is
 * already dismissed (or there is none: an aggregate with no members clears any prior
 * one). A slot holds one notice per subject and one aggregate per kind, so a surface
 * can call this from a poll: the same events rendered again leave the element as it is
 * (a live region announces on change, and a repaint must not pull focus off the
 * dismiss), and a changed set of events, or a new version, replaces it rather than
 * stacking a duplicate.
 */
export function notice(slot: Element | null, spec: NoticeSpec): HTMLElement | null {
  if (!slot) {
    return null;
  }
  const { kind, members, markup } = spec;
  const all: NoticeMember[] = members ?? [
    { subject: spec.subject ?? "", version: spec.version ?? "" },
  ];
  const id = members ? `${kind}|*` : `${kind}|${spec.subject ?? ""}`;
  const events = all.map((m) => `${m.subject}@${m.version}`).join(",");
  const prior = [...slot.children].find(
    (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.notice === id,
  );
  const map = readDismissed();
  if (all.every((m) => map[noticeMemberKey(kind, m.subject)]?.v === String(m.version))) {
    prior?.remove();
    return null;
  }
  if (prior?.dataset.noticeEvents === events) {
    return prior;
  }
  const el = document.createElement("div");
  el.className = "notice";
  el.setAttribute("role", "status");
  el.dataset.notice = id;
  el.dataset.noticeEvents = events;
  setHtml(
    el,
    html`<span class="notice-text">${markup}</span><button type="button" class="icon notice-dismiss" aria-label="Dismiss">${icon("x")}</button>`,
  );
  const dismiss = el.querySelector<HTMLButtonElement>(".notice-dismiss");
  if (dismiss) {
    dismiss.onclick = () => {
      recordDismissed(kind, all);
      el.remove(); // nothing to animate: the reader clicked it away
    };
  }
  if (prior) {
    const refocus = prior.querySelector(".notice-dismiss") === document.activeElement;
    prior.replaceWith(el);
    if (refocus) {
      dismiss?.focus();
    }
  } else {
    slot.appendChild(el);
  }
  return el;
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
