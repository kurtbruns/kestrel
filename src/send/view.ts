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
export type { SendPhase };

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

  const phase = derivePhase(send.status, counts, hasRetries, due, wedged, refused);
  // A time to finish only while the send is handing off: paused (between ticks, halted,
  // wedged), an average over the whole send would promise a finish that is not coming.
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
