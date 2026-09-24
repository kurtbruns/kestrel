/**
 * Derive the in-flight reporting shape for `GET /sends/:id/progress`, and for each send
 * in `GET /sends/feed` (SPEC §8, §12).
 *
 * Everything here is computed from the send row's denormalized counters (`sends.c_*`)
 * plus one cheap retry probe — no aggregate over the audience — so a poll is a
 * single-row read however large the send. The reported **phase** is derived live, not
 * stored: it is the vocabulary the watch view reports, distinct from the persisted
 * send `state`. Two numbers are reported side by side because delivery lags dispatch
 * (§6): **dispatch** (provider-accepted vs total) finishes in seconds–minutes, while
 * **delivery** (webhook-confirmed vs accepted) settles over minutes–days — the record
 * keeps absorbing events after the send is "sent."
 */

import type { LiveSend, SendHalt, SendPhase, SendProgress, SendSummary } from "../../shared/sends";
import { countsOf, type SendCounts, type SendRow, type SendStatus } from "../db/sends";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { nextChangeAt } from "./feed";
import { isWedged } from "./wedged";

/** In flight too long (SPEC §12): still `sending` past the stuck threshold. The one
 *  rule behind `attention.stuck` and the send list's `stuck`. */
export function isStuck(send: Pick<SendRow, "status" | "started_at">, now: number): boolean {
  return (
    send.status === "sending" &&
    send.started_at != null &&
    now - send.started_at > STUCK_THRESHOLD_MS
  );
}

/**
 * The live reporting phase — derived from the counters and send row, never stored:
 *   - `scheduled`       waiting in the review window (not yet fired).
 *   - `due`             still `scheduled`, but the fire time has passed: the next sweep
 *                       tick starts it (past the missed threshold, `attention.missed` too).
 *   - `progressing`     actively handing recipients to the provider.
 *   - `retrying`        handing off, but with recipients already retried (transient errors).
 *   - `backing-off`     work remains but nothing is in flight — paused between sweep
 *                       ticks, or, while the provider is unavailable, until the halt's
 *                       next retry (`provider.halt.retry_at`).
 *   - `needs-attention` wedged: nothing left to hand off, and the last run released the
 *                       send with recipients in flight whose fate is unknown (§12) —
 *                       awaiting Resolve;
 *                       or refused: the provider refuses the account, which the operator
 *                       must fix before the send can go on.
 *   - `settling`        dispatch complete; delivery receipts still arriving.
 *   - `complete`        dispatched and every accepted recipient has a delivery receipt.
 *   - `canceled`        terminal, non-sent outcome.
 */
export type { SendPhase, SendProgress };

function derivePhase(
  status: SendStatus,
  counts: SendCounts,
  hasRetries: boolean,
  due: boolean,
  wedged: boolean,
  refused: boolean,
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
      if (counts.pending > 0) {
        return "backing-off"; // released the lease, waiting for the next sweep tick or retry
      }
      return "progressing";
    }
  }
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Build the progress shape from a send row (the list projection is enough: the frozen
 * bodies play no part). `hasRetries` is the cheap EXISTS probe (see `hasActiveRetries`)
 * — pass false when the send is not `sending`, where it never affects the phase.
 */
export function buildSendProgress(
  send: SendSummary,
  providerName: string,
  hasRetries: boolean,
  now: number,
): SendProgress {
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

  // Throughput / ETA from the average since the send started — cheap and single-row.
  // A cumulative rate (not a trailing window) is enough to steer expectations here;
  // it is only reported while actively sending.
  let ratePerMin: number | null = null;
  let etaMs: number | null = null;
  if (send.status === "sending" && send.started_at != null) {
    const elapsed = now - send.started_at;
    if (elapsed > 0 && done > 0) {
      ratePerMin = round((done / elapsed) * 60_000);
      const remaining = total - done;
      etaMs = remaining > 0 ? round((remaining * elapsed) / done) : 0;
    }
  }

  const acceptedTotal = counts.accepted + counts.delivered + counts.bounced + counts.complained;
  const confirmed = counts.delivered + counts.bounced + counts.complained;
  const deliveryPercent = acceptedTotal > 0 ? round((100 * confirmed) / acceptedTotal) : 0;

  // Wedged: the last run gave up on the recipients left in flight and released its lease
  // (`isWedged`). A run finishing its last batch, or one cut off whose lease has yet to run
  // out and be looked at, holds or held the lease, so it never reads as needing attention.
  const wedged = isWedged(send);
  const stuck = isStuck(send, now);
  const due = send.status === "scheduled" && send.fire_at <= now;
  const missed = due && send.fire_at < now - MISSED_THRESHOLD_MS;
  // The provider's standing refusal, while the send is still open to be retried.
  const halt: SendHalt | null =
    send.status === "sending" && send.halt_reason
      ? {
          reason: send.halt_reason,
          cause: send.halt_cause,
          error: send.halt_error ?? "",
          since: send.halted_at,
          retry_at: send.halt_retry_at,
        }
      : null;
  const refused = halt?.reason === "account";

  return {
    state: send.status,
    phase: derivePhase(send.status, counts, hasRetries, due, wedged, refused),
    total,
    counts,
    dispatch: { done, percent: dispatchPercent, rate_per_min: ratePerMin, eta_ms: etaMs },
    delivery: { confirmed, percent_of_accepted: deliveryPercent },
    provider: { name: providerName, halt },
    attention: { wedged, wedged_count: wedged ? counts.in_flight : 0, stuck, missed, refused },
    next_change_at: nextChangeAt(send, now),
  };
}

/** One send as `GET /sends/feed` reports it: which send, and the same progress shape
 *  `/progress` reports for it, so a page following it and its watch can't disagree. */
export function buildLiveSend(
  send: SendSummary,
  providerName: string,
  hasRetries: boolean,
  now: number,
): LiveSend {
  return {
    id: send.id,
    post_id: send.post_id,
    subject: send.subject,
    fire_at: send.fire_at,
    started_at: send.started_at,
    completed_at: send.completed_at,
    ...buildSendProgress(send, providerName, hasRetries, now),
  };
}
