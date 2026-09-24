/**
 * Build a `SendView` (SPEC §8, §12): the one shape every route carries a send in, from the
 * stored row, so the list, the send, the feed, and every action's answer read a send by the
 * same rules at the same moment.
 *
 * Everything here is computed from the send row's denormalized counters (`sends.c_*`)
 * plus one cheap retry probe — no aggregate over the audience — so a view is a single-row
 * read however large the send. The reported **phase** is derived live, not stored: it is
 * the vocabulary the watch reports, distinct from the persisted `status`. Two numbers are
 * reported side by side because delivery lags dispatch (§6): **dispatch** (provider-
 * accepted vs the audience) finishes in seconds–minutes, while **delivery** (webhook-
 * confirmed vs accepted) settles over minutes–days — the record keeps absorbing events
 * after the send is "sent." The lease is the send loop's own business and never leaves the
 * Worker; what it means for a reader is already in the phase, conditions, and actions.
 */

import type { SendHalt, SendPhase, SendSummary, SendView } from "../../shared/sends";
import { countsOf, type SendCounts, type SendStatus } from "../db/sends";
import type { Config } from "../env";
import { archiveUrl } from "../render/render";
import { sendActions, sendConditions } from "./conditions";
import { nextChangeAt } from "./feed";
import { isWedged } from "./wedged";

/**
 * The live reporting phase — derived from the counters and send row, never stored:
 *   - `scheduled`       waiting in the review window (not yet fired).
 *   - `due`             still `scheduled`, but the fire time has passed: the next sweep
 *                       tick starts it (past the missed threshold, the `missed` condition too).
 *   - `progressing`     handing recipients to the provider at the pace the platform allows,
 *                       including a send too large for one tick waiting for the next.
 *   - `retrying`        handing off, but with recipients already retried (transient errors).
 *   - `backing-off`     work remains, nothing is in flight, and the pause follows an error:
 *                       recipients waiting on their retry after a transient error, or the
 *                       provider unavailable until the halt's next retry
 *                       (`provider.halt.retry_at`).
 *   - `needs-attention` wedged: nothing left to hand off, and the last run released the
 *                       send with recipients in flight whose fate is unknown (§12) —
 *                       awaiting Resolve;
 *                       or refused: the provider refuses the account, which the operator
 *                       must fix before the send can go on.
 *   - `settling`        dispatch complete; delivery receipts still arriving.
 *   - `complete`        dispatched and every accepted recipient has a delivery receipt.
 *   - `canceled`        terminal, non-sent outcome.
 */
export type { SendPhase };

function derivePhase(
  status: SendStatus,
  counts: SendCounts,
  hasRetries: boolean,
  due: boolean,
  wedged: boolean,
  refused: boolean,
  unavailable: boolean,
): SendPhase {
  switch (status) {
    case "scheduled":
      return due ? "due" : "scheduled";
    case "canceled":
      return "canceled";
    case "sent":
      // Still absorbing receipts if any recipient is accepted-but-unconfirmed.
      return counts.accepted > 0 ? "settling" : "complete";
    default: {
      // sending
      if (wedged || refused) {
        // dispatched rows stuck in flight with no lease and nothing left to send, or the
        // provider refusing the account
        return "needs-attention";
      }
      if (counts.in_flight > 0) {
        return hasRetries ? "retrying" : "progressing";
      }
      // Work remains and nothing is in flight: the run released the lease. Only an error
      // makes that a back-off. The retry probe already tells one apart: a pending recipient
      // with attempts is one a transient error put back in the queue. Without either, the
      // tick's budget ran out on a healthy send, which the next tick carries on (SPEC §12).
      if (counts.pending > 0 && (hasRetries || unavailable)) {
        return "backing-off";
      }
      return "progressing";
    }
  }
}

function round(n: number): number {
  return Math.round(n);
}

/** The sweep's cadence: one tick a minute, on the minute (SPEC §6). */
const TICK_MS = 60_000;

/** What the finish allows for the last tick's own run, past the minute it starts on. The
 *  row keeps no record of how long a tick ran, so this is a flat few seconds: the last
 *  tick hands off only what is left, which is at most one tick's share. */
const TICK_RUN_MS = 5_000;

/** How long after a minute boundary, with no run holding the lease, the view still takes
 *  that minute's tick as not yet run: the cron fires a moment after the boundary, and
 *  until the tick takes the lease the counters cannot tell it waiting from it done. A
 *  tick that ends inside this reads as not yet run, for at most these few seconds. */
const TICK_START_GRACE_MS = 2_000;

/**
 * How fast a send hands off and when it should finish, counted in sweep ticks (SPEC §6,
 * §8): `perTick` recipients a tick, and `finishAt` the moment the last tick it needs
 * should end. Null while no tick has finished, since nothing yet says how much a tick
 * carries.
 *
 * A send too large for one tick goes out as a burst each minute, not a steady flow, so an
 * average over the seconds since the start would run fast just after each burst and
 * promise a finish ticks too soon. Counting ticks is exact up to the last tick's length:
 * the ticks run so far are the start tick plus one per minute boundary passed, `done`
 * over them is what a tick carries, the remaining recipients over that is the ticks
 * still needed, and the last of them starts on the minute that many ticks ahead.
 *
 * While a tick is running (`running`, its run holding the lease), the counters cannot
 * say how much of `done` that tick handed off, so it counts as half a tick: the estimate
 * may be a tick out for the seconds a tick runs, and is exact again once it ends. If the
 * rest fits in the running tick, the finish is that tick's end. A send that sat halted
 * counts the ticks it waited, so its estimate runs long after it resumes.
 */
export function tickEstimate(
  startedAt: number,
  total: number,
  done: number,
  running: boolean,
  now: number,
): { perTick: number; finishAt: number } | null {
  const remaining = Math.max(0, total - done);
  const startTick = Math.floor(startedAt / TICK_MS);
  const tick = Math.floor(now / TICK_MS);
  const tickStart = tick * TICK_MS;
  if (running) {
    const before = tick - startTick; // ticks finished before the running one
    if (before < 1 || done <= 0) {
      return null; // the start tick: no tick has finished to count by
    }
    const perTick = done / (before + 0.5);
    const room = perTick / 2; // what the running tick is taken to have left
    if (remaining <= room) {
      return { perTick, finishAt: Math.max(now, tickStart + TICK_RUN_MS) };
    }
    const after = Math.ceil((remaining - room) / perTick);
    return { perTick, finishAt: tickStart + after * TICK_MS + TICK_RUN_MS };
  }
  // Between ticks: this minute's tick has run unless the boundary has only just passed.
  const waiting = tick > startTick && now - tickStart < TICK_START_GRACE_MS;
  const ran = tick - startTick + (waiting ? 0 : 1);
  if (ran < 1 || done <= 0) {
    return null;
  }
  const perTick = done / ran;
  if (remaining === 0) {
    return { perTick, finishAt: now };
  }
  const nextTick = waiting ? tickStart : tickStart + TICK_MS;
  const ticks = Math.ceil(remaining / perTick);
  return { perTick, finishAt: nextTick + (ticks - 1) * TICK_MS + TICK_RUN_MS };
}

/** A stored send as a view reads it: the row without its frozen bodies, and its post's
 *  slug, which names the published post's archive page. */
export type SendViewRow = SendSummary & { post_slug: string | null };

/**
 * Build the view of a send (the frozen bodies play no part). `hasRetries` is the cheap
 * EXISTS probe (see `hasActiveRetries`) — pass false when the send is not `sending`, where
 * it never affects the phase. `now` is the server's clock for everything derived, carried
 * as `as_of`.
 */
export function buildSendView(
  send: SendViewRow,
  config: Pick<Config, "provider" | "archiveOrigin" | "archiveBasePath">,
  hasRetries: boolean,
  now: number,
): SendView {
  const counts = countsOf(send);
  const summed =
    counts.pending +
    counts.in_flight +
    counts.accepted +
    counts.delivered +
    counts.bounced +
    counts.complained +
    counts.skipped +
    counts.unsent;
  const total = summed > 0 ? summed : send.recipient_count;

  const done = Math.max(0, total - counts.pending - counts.in_flight);
  const dispatchPercent = total > 0 ? round((100 * done) / total) : 0;

  // Throughput and time to finish, counted in sweep ticks (`tickEstimate`). Reported only
  // while sending; the time to finish only while handing off (below).
  const running = send.locked_until !== null && send.locked_until > now;
  const estimate =
    send.status === "sending" && send.started_at != null
      ? tickEstimate(send.started_at, total, done, running, now)
      : null;
  const ratePerMin = estimate ? round(estimate.perTick) : null;
  const etaMs = estimate ? Math.max(0, round(estimate.finishAt - now)) : null;

  const acceptedTotal = counts.accepted + counts.delivered + counts.bounced + counts.complained;
  const confirmed = counts.delivered + counts.bounced + counts.complained;
  const deliveryPercent = acceptedTotal > 0 ? round((100 * confirmed) / acceptedTotal) : 0;
  const id = send.id;

  // Wedged: the last run gave up on the recipients left in flight and released its lease
  // (`isWedged`). A run finishing its last batch, or one cut off whose lease has yet to run
  // out and be looked at, holds or held the lease, so it never reads as needing attention.
  const wedged = isWedged(send);
  const due = send.status === "scheduled" && send.fire_at <= now;
  // The provider's standing refusal, while the send is still open to be retried.
  const halt: SendHalt | null =
    send.status === "sending" && send.halt_reason
      ? {
          reason: send.halt_reason,
          cause: send.halt_cause,
          error: send.halt_error ?? "",
          retries: send.halt_retries,
          since: send.halted_at,
          retry_at: send.halt_retry_at,
        }
      : null;
  const refused = halt?.reason === "account";
  const unavailable = halt?.reason === "unavailable";

  const phase = derivePhase(send.status, counts, hasRetries, due, wedged, refused, unavailable);
  // A time to finish only while the send is handing off: paused (backing off, halted,
  // wedged), the ticks ahead would not hand anyone off, so a finish counted from them is
  // not coming. Between ticks a healthy send is still handing off: the estimate counts the
  // wait for the next tick.
  const handingOff = phase === "progressing" || phase === "retrying";

  return {
    id,
    post_id: send.post_id,
    subject: send.subject,
    status: send.status,
    rev: send.rev,
    as_of: now,
    fire_at: send.fire_at,
    scheduled_at: send.scheduled_at,
    started_at: send.started_at,
    completed_at: send.completed_at,
    remade_at: send.remade_at,
    tested_at: send.tested_at,
    audience: {
      count: total,
      fixed: send.audience_resolved_at !== null,
      fixed_at: send.audience_resolved_at,
    },
    counts,
    dispatch: {
      done,
      percent: dispatchPercent,
      rate_per_min: ratePerMin,
      eta_ms: handingOff ? etaMs : null,
    },
    delivery: { confirmed, percent_of_accepted: deliveryPercent },
    provider: { name: config.provider, halt },
    phase,
    conditions: sendConditions(send, now),
    actions: sendActions(send, now),
    next_change_at: nextChangeAt(send, now),
    links: {
      self: `/sends/${id}`,
      email_html: `/sends/${id}/email?format=html`,
      email_text: `/sends/${id}/email?format=text`,
      deliveries: `/sends/${id}/deliveries`,
      deliveries_csv: `/sends/${id}/deliveries.csv`,
      post: `/posts/${send.post_id}`,
      // The archive serves a post's page only once it is sent: before, the link would 404.
      archive:
        send.status === "sent" && send.post_slug !== null
          ? archiveUrl(config, send.post_slug)
          : null,
    },
  };
}
