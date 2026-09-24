// What a send's counters say, shared by the list, the record, and the dashboard: who needs
// the operator, the Delivered cell, the in-progress card, the countdowns, and the small
// number formats.

import {
  type LiveSend,
  type SendCounts,
  type SendSummary,
  STUCK_THRESHOLD_MS,
} from "../../shared/sends";
import { every } from "../lifecycle";
import { $$ } from "../ui/dom";
import { untilStr } from "../ui/format";
import { type Html, html } from "../ui/html";

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

/**
 * The live "Sends in …" cells under `root`, ticking once a second for the life of the
 * mount. Returns the tick, for a section that re-renders its cards: a fresh cell is
 * empty until the next tick paints it.
 */
export function countdowns(root: ParentNode, signal: AbortSignal): () => void {
  const tick = () => {
    for (const el of $$<HTMLElement>("[data-fire]", root)) {
      el.textContent = untilStr(Number(el.dataset.fire));
    }
  };
  every(1000, tick, signal);
  return tick;
}

// The refusal advice lives in shared/, so the notification that emails it words it the same way.
export { refusalAdvice } from "../../shared/sends";

/** The provider's words for a refusal, as a sentence the copy around them can follow: their
 *  own closing stop kept ("…quota exceeded."), one added only when they have none. */
export function providerWords(error: string | null | undefined): string {
  const text = error?.trim() || "no detail given";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A send that needs the operator rather than patience (SPEC §12): wedged on ambiguous
 * deliveries, which only Resolve can settle without risking a double-mail (I4), or refused
 * by the provider, which only a fix to the account lifts. Its home is the attention block,
 * not the in-progress cards. The server decides both flags, so every page agrees.
 */
export function needsOperator(s: LiveSend): boolean {
  return s.attention.wedged || s.attention.refused;
}

/** The counts a Delivered cell reads. */
export type DeliveredCounts = Pick<SendCounts, "delivered" | "bounced" | "complained" | "unsent">;

/** A `/sends` list row's counters, as a Delivered cell reads them. */
export function rowCounts(s: SendSummary): DeliveredCounts {
  return {
    delivered: s.c_delivered,
    bounced: s.c_bounced,
    complained: s.c_complained,
    unsent: s.c_unsent,
  };
}

/**
 * A send's "Delivered" cell in the send lists, from its counters: a list row's (through
 * `rowCounts`), or a live send's as its receipts settle. It reports TRUE delivered
 * (webhook-confirmed, not provider-accepted), so the Sent list and the dashboard's Sent
 * table agree with the record view's "Delivered" for the same send, and a bounced or
 * complained recipient is never miscounted as delivered. Any bounce, complaint, or unsent
 * shows as a muted delivery-failure note beneath the count, worst first, so a bad send
 * reads as one at a glance. A clean send prints nothing.
 */
export function deliveredCell(c: DeliveredCounts): Html {
  const delivered = c.delivered || 0;
  const kinds: string[] = [];
  if (c.complained) {
    kinds.push(`${c.complained.toLocaleString()} complained`);
  }
  if (c.bounced) {
    kinds.push(`${c.bounced.toLocaleString()} bounced`);
  }
  if (c.unsent) {
    kinds.push(`${c.unsent.toLocaleString()} unsent`);
  }
  // Each kind is one unbreakable unit, so a wrap lands between kinds, never inside one.
  const note = kinds.length
    ? html`<span class="muted delivered-note">${kinds.map((text, i) => html`${i ? ", " : ""}<span class="delivered-kind">${text}</span>`)}</span>`
    : null;
  return html`<span class="n">${delivered.toLocaleString()}</span>${note}`;
}

/**
 * One in-progress send as a card with a live mini dispatch bar, its counts, and a Watch
 * link, from the layer's read. The bar is accepted over the audience, as the watch's
 * dispatch bar is, and the time to finish is the server's, shown only while the send is
 * handing off, never while it is paused. A send in flight too long says so on its card.
 * The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
 */
export function activeRowHtml(s: LiveSend): Html {
  const c = s.counts;
  const accepted = c.accepted + c.delivered + c.bounced + c.complained;
  const confirmed = c.delivered + c.bounced + c.complained;
  const pct = s.total > 0 ? (100 * accepted) / s.total : 0;
  const handingOff = s.phase === "progressing" || s.phase === "retrying";
  const eta = handingOff && s.dispatch.eta_ms ? ` · ~${fmtDuration(s.dispatch.eta_ms)} left` : "";
  return html`<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${s.subject || html`<em>untitled</em>`}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(pct)}%"></div></div>
        <div class="muted active-stat">Sending — ${accepted.toLocaleString()} of ${s.total.toLocaleString()} accepted${
          confirmed ? ` · ${confirmed.toLocaleString()} confirmed` : ""
        }${eta}</div>
        ${
          s.attention.stuck
            ? html`<div class="active-stuck">In progress over ${STUCK_THRESHOLD_MS / 60_000} minutes; it may be retrying.</div>`
            : null
        }
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}
