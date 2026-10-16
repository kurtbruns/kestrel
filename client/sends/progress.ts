// What a send's view says, shared by the list, the record, and the dashboard: a page's sends
// as they stand, its conditions and actions, who needs the operator, the Delivered cell,
// the in-progress card, the scheduled cards' countdowns, the Email only marks, and the small
// number formats.

import type {
  ConditionKind,
  SendAction,
  SendCondition,
  SendCounts,
  SendView,
} from "../../shared/sends";
import { at, every } from "../lifecycle";
import { $$ } from "../ui/dom";
import { lateStr, untilStr } from "../ui/format";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";

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

/** A post's title in a list of sends or drafts (DESIGN §3), with a muted envelope and "Email
 *  only" after it for an email-only post: only the exception is marked, so a listed post's
 *  title stands alone. Words rather than a pill, so it never reads as a second status beside
 *  the row's own; the title wraps within its room and the mark stays on its line. */
export function titleWithLabel(title: Html, s: { email_only: boolean }): Html {
  return s.email_only
    ? html`<span class="title-with-label"><span class="title-text">${title}</span><span class="email-only-mark">${icon("mail")}Email only</span></span>`
    : title;
}

/** What a scheduled card's line adds for an email-only post (DESIGN §4): only the
 *  exception is marked, since being listed is the default. */
export function emailOnlyNote(s: Pick<SendView, "email_only">): Html | null {
  return s.email_only ? html` · <span class="sched-email-only">Email only</span>` : null;
}

/**
 * A scheduled card's countdown cell, from its `GET /api/sends` row: the fire time, whether the
 * server reads the send due, and whether it is past the missed tolerance. Empty until
 * `countdowns` words it.
 */
export function countdownHtml(s: SendView): Html {
  return html`<span class="countdown" data-fire="${s.fire_at}"${s.phase === "due" && html` data-due`}${has(s, "missed") && html` data-missed`}></span>`;
}

/**
 * The live countdown cells under `root`, ticking once a second for the life of the mount:
 * "Sends in …" before the fire time; "Preparing to send…" from the fire time (by the clock,
 * or sooner when the server already reads the send due) until the send starts and its card
 * leaves the queue; and, past the server's missed tolerance, how late it is, in the danger
 * tone. A card's window controls (`data-closes`, Cancel and Edit schedule) hide at the fire
 * time, when the review window closes (SPEC §6) and the server would refuse them, rather
 * than wait for the next read. A fire time inside the coming second gets a tick of its own
 * at that moment, so the switch lands when the countdown runs out, not up to a second
 * after. Controls hidden this way stay hidden: a card is re-rendered only from a read, whose
 * `actions` decide what it offers. Returns the tick, for a section that re-renders its
 * cards: a fresh cell is empty until the next tick paints it.
 */
export function countdowns(root: ParentNode, signal: AbortSignal): () => void {
  let armed = 0; // the moment an extra tick is set for, so a repeated tick sets it once
  const tick = () => {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    const watch = (moment: number) => {
      if (moment > now && moment < next) {
        next = moment;
      }
    };
    for (const el of $$<HTMLElement>("[data-closes]", root)) {
      const closes = Number(el.dataset.closes);
      el.hidden = now >= closes;
      watch(closes);
    }
    for (const el of $$<HTMLElement>("[data-fire]", root)) {
      const fire = Number(el.dataset.fire);
      const missed = el.dataset.missed !== undefined;
      el.textContent = missed ? lateStr(fire) : untilStr(fire, el.dataset.due !== undefined);
      el.classList.toggle("countdown-missed", missed);
      watch(fire);
    }
    if (next - now <= 1000 && next !== armed) {
      armed = next;
      at(next, tick, signal);
    }
  };
  every(1000, tick, signal);
  return tick;
}

/** Whether the server reports an open condition of `kind` on the send. */
export const has = (s: { conditions: SendCondition[] }, kind: ConditionKind): boolean =>
  s.conditions.some((c) => c.kind === kind);

/** The send's open condition of `kind`, as the server words it, if any. */
export function conditionOf<K extends ConditionKind>(
  s: { conditions: SendCondition[] },
  kind: K,
): Extract<SendCondition, { kind: K }> | undefined {
  return s.conditions.find((c) => c.kind === kind) as
    | Extract<SendCondition, { kind: K }>
    | undefined;
}

/** Whether the server would take the action on the send now: a control is offered only then. */
export const can = (s: { actions: SendAction[] }, name: SendAction["name"]): boolean =>
  s.actions.some((a) => a.name === name);

/**
 * A page's sends as they stand: each row it read, replaced by the layer's latest report of
 * that send once there is one, then every reported send it did not read. The layer reports
 * every change after the page's read, so a report is never older than the row it replaces;
 * both are the one `SendView`, so nothing is converted.
 */
export function sendsNow(
  rows: readonly SendView[],
  reported: ReadonlyMap<string, SendView>,
): SendView[] {
  const listed = new Set(rows.map((r) => r.id));
  return [
    ...rows.map((r) => reported.get(r.id) ?? r),
    ...[...reported.values()].filter((s) => !listed.has(s.id)),
  ];
}

/**
 * A send that needs the operator rather than patience (SPEC §12): wedged on ambiguous
 * deliveries, which only Resolve can settle without risking a double-mail (I4), or refused
 * by the provider, which only a fix to the account lifts. Its home is the attention block,
 * not the in-progress cards. The server decides both conditions, so every page agrees.
 */
export function needsOperator(s: SendView): boolean {
  return has(s, "wedged") || has(s, "refused");
}

/** The counts a Delivered cell reads. */
export type DeliveredCounts = Pick<SendCounts, "delivered" | "bounced" | "complained" | "unsent">;

/**
 * A send's "Delivered" cell in the send lists, from its counts: a list row's, or a live send's as its receipts settle. It reports TRUE delivered
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

/** When a halted send's next retry is due, relative to now (SPEC §12). */
export function nextRetry(retryAt: number | null): string {
  if (retryAt === null) {
    return "it is retried on its own";
  }
  const wait = retryAt - Date.now();
  return wait > 0 ? `next retry in ${fmtDuration(wait)}` : "next retry due now";
}

/**
 * One in-progress send as a card with a live mini dispatch bar, its counts, and a Watch
 * link, from the layer's read. The bar is accepted over the audience, as the watch's
 * dispatch bar is, and the time to finish is the server's, shown only while the send is
 * handing off, never while it is paused. A send paused for a provider outage leads with
 * that and when it next retries, since nothing goes out until then (SPEC §12). A send in
 * flight too long says so on its card, unless the page already says so in its health line
 * (`stuckNote: false`, the dashboard), so the words aren't shown twice.
 * The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
 */
export function activeRowHtml(s: SendView, { stuckNote = true } = {}): Html {
  const c = s.counts;
  const accepted = c.accepted + c.delivered + c.bounced + c.complained;
  const confirmed = c.delivered + c.bounced + c.complained;
  const total = s.audience.count;
  const pct = total > 0 ? (100 * accepted) / total : 0;
  // The server gives a time to finish only while the send is handing off.
  const eta = s.dispatch.eta_ms ? ` · ~${fmtDuration(s.dispatch.eta_ms)} left` : "";
  const stuck = stuckNote ? conditionOf(s, "stuck") : undefined;
  const halt = s.provider.halt;
  const outage = s.phase === "backing-off" && halt?.reason === "unavailable";
  const lead = outage ? "Backing off" : "Sending";
  const retry = outage ? ` · provider unavailable, ${nextRetry(halt.retry_at)}` : "";
  return html`<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${s.subject || html`<em>untitled</em>`}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(pct)}%"></div></div>
        <div class="muted active-stat">${lead}: ${accepted.toLocaleString()} of ${total.toLocaleString()} accepted${
          confirmed ? ` · ${confirmed.toLocaleString()} confirmed` : ""
        }${eta}${retry}</div>
        ${stuck ? html`<div class="active-stuck">${stuck.message}</div>` : null}
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}
