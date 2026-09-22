// @ts-nocheck
// The dismissible notice (DESIGN §2), the busy state, and the error view.

import { esc } from "./helpers";
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
function readDismissed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTICE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writeDismissed(map) {
  try {
    localStorage.setItem(NOTICE_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked or full: the notice simply shows again next time */
  }
}
const noticeMemberKey = (kind, subject) => `${kind}|${subject}`;
function recordDismissed(kind, members) {
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
// Returns the rendered element, or null when every member is already dismissed (or there
// is none: an aggregate with no members clears any prior one). A slot holds one notice per
// subject and one aggregate per kind, so a surface can call this from a poll: the same
// events rendered again leave the element as it is (a live region announces on change,
// and a repaint must not pull focus off the dismiss), and a changed set of events, or a
// new version, replaces it rather than stacking a duplicate.
export function notice(slot, { kind, subject, version, members, html }) {
  if (!slot) {
    return null;
  }
  const all = members || [{ subject, version }];
  const id = members ? `${kind}|*` : `${kind}|${subject}`;
  const events = all.map((m) => `${m.subject}@${m.version}`).join(",");
  const prior = Array.from(slot.children).find((c) => c.dataset.notice === id);
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
  el.innerHTML = `<span class="notice-text">${html}</span><button type="button" class="icon notice-dismiss" aria-label="Dismiss">${icon("x")}</button>`;
  const dismiss = el.querySelector(".notice-dismiss");
  dismiss.onclick = () => {
    recordDismissed(kind, all);
    el.remove(); // nothing to animate: the reader clicked it away
  };
  if (prior) {
    const refocus = prior.querySelector(".notice-dismiss") === document.activeElement;
    prior.replaceWith(el);
    if (refocus) {
      dismiss.focus();
    }
  } else {
    slot.appendChild(el);
  }
  return el;
}

export async function busy(btn, label, fn) {
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
export function renderError(container, msg, retryFn) {
  container.innerHTML = `<div class="error"><span>${esc(msg)}</span><button class="ghost" data-retry>Retry</button></div>`;
  const b = container.querySelector("[data-retry]");
  if (b) {
    b.onclick = retryFn;
  }
}
