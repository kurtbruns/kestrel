// What a send's counters say, shared by the list, the record, and the dashboard: the
// wedge test, the list row's cells, the countdowns, and the small number formats.

import type { SendSummary } from "../../shared/sends";
import { $$ } from "../dom";
import { untilStr } from "../helpers";
import { type Html, html } from "../html";
import { appState } from "../state";

/** A percentage clamped to 0–100 and rounded. */
export const clampPct = (n: number | null | undefined): number =>
  Math.max(0, Math.min(100, Math.round(n || 0)));

/** A rough duration, coarsening with size: "45s", "12 min", "3 hr"; an em dash for none. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const s = Math.round(ms / 1000);
  if (s < 90) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  if (m < 90) {
    return `${m} min`;
  }
  return `${Math.round(m / 60)} hr`;
}

export function startCountdowns(): void {
  // Clear any prior interval first: reloadAll() re-runs loadScheduled (and this) on
  // every cancel/resolve, so without this each refresh would leak a 1s interval.
  if (appState.statusTimer) {
    clearInterval(appState.statusTimer);
  }
  const tick = () => {
    for (const el of $$<HTMLElement>("[data-fire]")) {
      el.textContent = untilStr(Number(el.dataset.fire));
    }
  };
  tick();
  appState.statusTimer = setInterval(tick, 1000);
}

/**
 * A send wedged on ambiguous in-flight rows: still `sending`, nothing left pending, but
 * one or more in-flight recipients whose fate a transport error left unknown (SPEC §12).
 * This is the state the sweep flags and the operator must adjudicate; it can't clear on
 * its own without risking a double-mail (I4). Read straight off the row's denormalized
 * counters, the same signals the server derives `wedged` from, so the list and the
 * watch agree. The lease check is essential: while the loop is actively working a send
 * it holds the lease (`locked_until` in the future), so a normal send's final dispatched
 * batch (pending 0, in flight > 0) is not a wedge, just work in progress. A genuine wedge
 * has released the lease.
 */
export function isWedged(s: SendSummary): boolean {
  const leaseHeld = s.locked_until != null && s.locked_until > Date.now();
  return s.status === "sending" && !(s.c_pending || 0) && (s.c_in_flight || 0) > 0 && !leaseHeld;
}

// Dispatch/delivery numbers from a `/sends` list row's denormalized counters, so the
// active-send row and the dashboard widget need no per-send /progress read. `done` is
// the dispatch fraction (accepted vs the frozen total), matching the watch's dispatch bar.
function listRowCounts(s: SendSummary) {
  const total =
    (s.c_pending || 0) +
    (s.c_in_flight || 0) +
    (s.c_accepted || 0) +
    (s.c_delivered || 0) +
    (s.c_bounced || 0) +
    (s.c_complained || 0) +
    (s.c_skipped || 0) +
    (s.c_unsent || 0);
  const t = total > 0 ? total : s.recipient_count || 0;
  const done =
    (s.c_accepted || 0) + (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const confirmed = (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const pct = t > 0 ? Math.round((100 * done) / t) : 0;
  // Rough ETA from the average rate since the send started — the same cumulative
  // estimate /progress reports, computed here off the list row so no extra read is needed.
  let etaMs: number | null = null;
  if (s.started_at && done > 0 && t > done) {
    const elapsed = Date.now() - s.started_at;
    if (elapsed > 0) {
      etaMs = ((t - done) * elapsed) / done;
    }
  }
  return { total: t, accepted: done, confirmed, pct, etaMs };
}

/**
 * A `/sends` list row's "Delivered" cell, from its denormalized counters. It reports TRUE
 * delivered (webhook-confirmed `c_delivered`, not provider-`accepted`), so the Sent list
 * and dashboard recent-sends agree with the record view's "Delivered" for the same send,
 * and a bounced/complained recipient is never miscounted as delivered. Any bounce /
 * complaint / unsent shows as a muted delivery-failure note beneath the count, worst
 * first, so a bad send reads as one at a glance. A clean send prints nothing.
 */
export function deliveredCell(s: SendSummary): Html {
  const delivered = s.c_delivered || 0;
  const kinds: string[] = [];
  if (s.c_complained) {
    kinds.push(`${s.c_complained.toLocaleString()} complained`);
  }
  if (s.c_bounced) {
    kinds.push(`${s.c_bounced.toLocaleString()} bounced`);
  }
  if (s.c_unsent) {
    kinds.push(`${s.c_unsent.toLocaleString()} unsent`);
  }
  // Each kind is one unbreakable unit, so a wrap lands between kinds, never inside one.
  const note = kinds.length
    ? html`<span class="muted delivered-note">${kinds.map((text, i) => html`${i ? ", " : ""}<span class="delivered-kind">${text}</span>`)}</span>`
    : null;
  return html`<span class="n">${delivered.toLocaleString()}</span>${note}`;
}

/**
 * One in-progress send as a card with a live mini dispatch bar, an ETA, and a Watch link.
 * The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
 */
export function activeRowHtml(s: SendSummary): Html {
  const c = listRowCounts(s);
  const eta = c.etaMs != null ? ` · ~${fmtDuration(c.etaMs)} left` : "";
  return html`<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${s.subject || html`<em>untitled</em>`}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(c.pct)}%"></div></div>
        <div class="muted active-stat">Sending — ${c.accepted.toLocaleString()} of ${c.total.toLocaleString()} accepted${
          c.confirmed ? ` · ${c.confirmed.toLocaleString()} confirmed` : ""
        }${eta}</div>
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}
