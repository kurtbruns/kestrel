/**
 * Derive the in-flight reporting shape for `GET /sends/:id/progress` (SPEC §8, §11).
 *
 * Everything here is computed from the send row's denormalized counters (migration
 * 0006) plus one cheap retry probe — no aggregate over the audience — so a poll is a
 * single-row read however large the send. The reported **phase** is derived live, not
 * stored: it is the vocabulary the watch view reports, distinct from the persisted
 * send `state`. Two numbers are reported side by side because delivery lags dispatch
 * (§6): **dispatch** (provider-accepted vs total) finishes in seconds–minutes, while
 * **delivery** (webhook-confirmed vs accepted) settles over minutes–days — the record
 * keeps absorbing events after the send is "sent."
 */

import { countsOf, type SendCounts, type SendRow, type SendStatus } from "../db/sends";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";

/**
 * The live reporting phase — derived from the counters and send row, never stored:
 *   - `scheduled`       waiting in the review window (not yet fired).
 *   - `progressing`     actively handing recipients to the provider.
 *   - `retrying`        handing off, but with recipients already retried (transient errors).
 *   - `backing-off`     work remains but nothing is in flight — paused between sweep
 *                       ticks (a rate-limit pause or retry backoff waiting for the next tick).
 *   - `needs-attention` wedged: nothing left to hand off, but recipients stuck in flight
 *                       whose fate a transport error left unknown (§11) — awaiting Resolve.
 *   - `settling`        dispatch complete; delivery receipts still arriving.
 *   - `complete`        dispatched and every accepted recipient has a delivery receipt.
 *   - `failed` / `canceled`  terminal, non-sent outcomes.
 */
export type SendPhase =
  | "scheduled"
  | "progressing"
  | "retrying"
  | "backing-off"
  | "needs-attention"
  | "settling"
  | "complete"
  | "failed"
  | "canceled";

export interface SendProgress {
  state: SendStatus;
  phase: SendPhase;
  /** The frozen audience size — the materialized total, or the schedule-time estimate
   *  before any recipient rows exist. */
  total: number;
  counts: SendCounts;
  /** Provider hand-off: how far the send loop has gotten. */
  dispatch: {
    /** Recipients the loop has finished with (accepted, failed, or skipped). */
    done: number;
    percent: number;
    /** Recipients accepted per minute since the send started (null when not sending). */
    rate_per_min: number | null;
    /** Rough time to finish dispatch from the average rate (null when not computable). */
    eta_ms: number | null;
  };
  /** Delivery confirmation, which lags acceptance (§6). */
  delivery: {
    /** Accepted recipients with a delivery receipt (delivered / bounced / complained). */
    confirmed: number;
    percent_of_accepted: number;
  };
  provider: { name: string };
  /** The loud conditions (§11) the watch surfaces — Resolve appears when `wedged`. */
  attention: { wedged: boolean; wedged_count: number; stuck: boolean; missed: boolean };
}

function derivePhase(status: SendStatus, counts: SendCounts, hasRetries: boolean): SendPhase {
  switch (status) {
    case "scheduled":
      return "scheduled";
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
    case "sent":
      // Still absorbing receipts if any recipient is accepted-but-unconfirmed.
      return counts.accepted > 0 ? "settling" : "complete";
    default: {
      // sending
      if (counts.pending === 0 && counts.in_flight > 0) {
        return "needs-attention"; // wedged: nothing left to send, rows stuck in flight
      }
      if (counts.in_flight > 0) {
        return hasRetries ? "retrying" : "progressing";
      }
      if (counts.pending > 0) {
        return "backing-off"; // released the lease, waiting for the next sweep tick
      }
      return "progressing";
    }
  }
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Build the progress shape from a send row. `hasRetries` is the cheap EXISTS probe
 * (see `hasActiveRetries`) — pass false when the send is not `sending`, where it never
 * affects the phase.
 */
export function buildSendProgress(
  send: SendRow,
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
    counts.failed;
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

  const wedged = send.status === "sending" && counts.pending === 0 && counts.in_flight > 0;
  const stuck =
    send.status === "sending" &&
    send.started_at != null &&
    now - send.started_at > STUCK_THRESHOLD_MS;
  const missed = send.status === "scheduled" && send.fire_at < now - MISSED_THRESHOLD_MS;

  return {
    state: send.status,
    phase: derivePhase(send.status, counts, hasRetries),
    total,
    counts,
    dispatch: { done, percent: dispatchPercent, rate_per_min: ratePerMin, eta_ms: etaMs },
    delivery: { confirmed, percent_of_accepted: deliveryPercent },
    provider: { name: providerName },
    attention: { wedged, wedged_count: wedged ? counts.in_flight : 0, stuck, missed },
  };
}
