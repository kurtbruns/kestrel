// What a send's counters say, shared by the list, the record, and the dashboard: a send as
// it stands, who needs the operator, the Delivered cell, the in-progress card, the
// scheduled cards' countdowns, and the small number formats.

import {
  type LiveSend,
  type SendAttention,
  type SendCounts,
  type SendHalt,
  type SendListItem,
  type SendPhase,
  type SendStatus,
  type SendSummary,
  STUCK_THRESHOLD_MS,
} from "../../shared/sends";
import { every } from "../lifecycle";
import { $$ } from "../ui/dom";
import { lateStr, untilStr } from "../ui/format";
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
 * A scheduled card's countdown cell, from its `GET /sends` row: the fire time, whether the
 * server reads the send due, and whether it is past the missed tolerance. Empty until
 * `countdowns` words it.
 */
export function countdownHtml(s: SendListItem): Html {
  return html`<span class="countdown" data-fire="${s.fire_at}"${s.phase === "due" && html` data-due`}${s.attention.missed && html` data-missed`}></span>`;
}

/**
 * The live countdown cells under `root`, ticking once a second for the life of the mount:
 * "Sends in …" before the fire time; "Preparing to send…" from the fire time (by the clock,
 * or sooner when the server already reads the send due) until the send starts and its card
 * leaves the queue; and, past the server's missed tolerance, how late it is, in the danger
 * tone. Returns the tick, for a section that re-renders its cards: a fresh cell is empty
 * until the next tick paints it.
 */
export function countdowns(root: ParentNode, signal: AbortSignal): () => void {
  const tick = () => {
    for (const el of $$<HTMLElement>("[data-fire]", root)) {
      const fire = Number(el.dataset.fire);
      const missed = el.dataset.missed !== undefined;
      el.textContent = missed ? lateStr(fire) : untilStr(fire, el.dataset.due !== undefined);
      el.classList.toggle("countdown-missed", missed);
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
 * What the in-progress card, the attention lines, and a Delivered cell read of a send: the
 * layer's `LiveSend` as it stands, or a page's `GET /sends` row (`rowView`) until the layer
 * reports that send.
 */
export interface SendView {
  id: string;
  subject: string;
  state: SendStatus;
  phase: SendPhase;
  total: number;
  counts: SendCounts;
  attention: SendAttention;
  dispatch: { eta_ms: number | null };
  provider: { halt: Pick<SendHalt, "cause" | "error"> | null };
}

/** A `GET /sends` row as a send view; it carries no time to finish, which the layer's next report of the send brings. */
export function rowView(s: SendListItem): SendView {
  return {
    id: s.id,
    subject: s.subject,
    state: s.status,
    phase: s.phase,
    total: s.recipient_count,
    counts: {
      pending: s.c_pending,
      in_flight: s.c_in_flight,
      accepted: s.c_accepted,
      delivered: s.c_delivered,
      bounced: s.c_bounced,
      complained: s.c_complained,
      skipped: s.c_skipped,
      unsent: s.c_unsent,
    },
    attention: s.attention,
    dispatch: { eta_ms: null },
    provider: { halt: s.halt_reason ? { cause: s.halt_cause, error: s.halt_error ?? "" } : null },
  };
}

/**
 * A page's sends as they stand: each row it read, overlaid by the layer's latest report of
 * that send once there is one, then every reported send it did not read. The layer reports
 * every change after the page's read, so a report is never older than the row it replaces.
 */
export function sendsNow(
  rows: readonly SendListItem[],
  reported: ReadonlyMap<string, LiveSend>,
): SendView[] {
  const listed = new Set(rows.map((r) => r.id));
  return [
    ...rows.map((r) => reported.get(r.id) ?? rowView(r)),
    ...[...reported.values()].filter((s) => !listed.has(s.id)),
  ];
}

/**
 * A send that needs the operator rather than patience (SPEC §12): wedged on ambiguous
 * deliveries, which only Resolve can settle without risking a double-mail (I4), or refused
 * by the provider, which only a fix to the account lifts. Its home is the attention block,
 * not the in-progress cards. The server decides both flags, so every page agrees.
 */
export function needsOperator(s: SendView): boolean {
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
export function activeRowHtml(s: SendView): Html {
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
