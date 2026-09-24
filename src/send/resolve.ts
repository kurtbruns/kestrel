/**
 * Operator adjudication of a wedged send (SPEC §12).
 *
 * On a non-idempotent provider (e.g. SES) a mid-batch transport error — the
 * request left but no response came back — leaves its recipients `dispatched`:
 * genuinely ambiguous, because we cannot know whether the provider accepted them.
 * The send loop deliberately refuses to blind-retry those rows (that refusal is
 * what protects I4 without a provider idempotency key), so the send can never
 * satisfy its completion gate (`pending == 0 && dispatched == 0`). Once the run that left
 * them releases the send it is wedged (`WEDGED_SEND`): it stays `sending`, the sweep no
 * longer runs it, and it is flagged (`send.wedged`, then `send.stuck`), with no way to act
 * on the flag but raw SQL, were it not for this.
 *
 * This is the one place a human resolves that ambiguity, choosing the safe outcome:
 *   - "unsent":   assume the batch never left. The addresses are simply picked up by
 *                 the NEXT post (a future send resolves its audience fresh); they
 *                 are never re-mailed within THIS send.
 *   - "accepted": assume it did (the operator confirmed in the provider console),
 *                 which lets the send complete.
 *
 * After resolving, it runs the loop's own completion gate, so a resolved send
 * finishes exactly as a clean one would. Only `dispatched` rows are ever touched —
 * an already-`accepted` recipient is never re-mailed by any of this (I4).
 *
 * It holds the send's lease while it works, as a run does. A run in progress may have
 * rows `dispatched` that are only waiting for the provider's answer, and settling those
 * would put the publisher's guess in place of the provider's answer, so while a run holds
 * the send, Resolve is refused and can be tried again a moment later.
 */

import type { StuckResolution } from "../../shared/sends";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { notFound, refusal } from "../lib/errors";
import { LEASE_TTL_MS } from "../lib/time";
import { viewSend } from "./describe";
import { isWedged } from "./wedged";

// The resolution lives in shared/ so the editor reads the same definition.
export type { StuckResolution };

/** What a Resolve did: how many ambiguous recipients it settled, and whether the send
 *  then finished. The route answers with the send as it now stands beside these. */
export interface ResolveResult {
  resolved: number;
  completed: boolean;
}

/** What a Resolve may carry: the `rev` the caller last read (`If-Match`), and how many
 *  ambiguous recipients it saw, so it never settles a different set than the one it meant. */
export interface ResolveGuard {
  ifMatch?: number;
  expectedCount?: number;
}

/**
 * Adjudicate the ambiguous (`dispatched`) rows of a wedged send. Refused, each with its
 * own code and the send as it stands: `precondition_failed` when the send has changed
 * since the `rev` the caller read, `run_in_progress` while a run holds it, `not_wedged`
 * when it is not wedged (`isWedged`: nothing to resolve, or a run still to look at it),
 * and `count_changed` when the ambiguous count is not the one the caller saw.
 */
export async function resolveStuckSend(
  env: AppEnv,
  sendId: string,
  outcome: StuckResolution,
  actor: string,
  guard: ResolveGuard = {},
): Promise<ResolveResult> {
  const send = await sends.getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const refuse = async (status: 409 | 412, code: string, message: string) =>
    refusal(status, code, message, { send: await viewSend(env, send.id) });
  if (guard.ifMatch !== undefined && send.rev !== guard.ifMatch) {
    throw await refuse(
      412,
      "precondition_failed",
      `the send has changed since rev ${guard.ifMatch} (it is at rev ${send.rev}); read it again before resolving`,
    );
  }
  const now = Date.now();
  if (send.status === "sending" && send.locked_until !== null && send.locked_until > now) {
    throw await refuse(
      409,
      "run_in_progress",
      "this send is being worked on right now; try Resolve again in a moment",
    );
  }
  if (!isWedged(send)) {
    throw await refuse(
      409,
      "not_wedged",
      send.status === "sending"
        ? "send is not wedged: it still has recipients to hand off, or a run has yet to look at those in flight"
        : `send is ${send.status}, with no ambiguous deliveries to resolve`,
    );
  }
  if (guard.expectedCount !== undefined && guard.expectedCount !== send.c_in_flight) {
    throw await refuse(
      409,
      "count_changed",
      `the send has ${send.c_in_flight} ambiguous recipients, not the ${guard.expectedCount} expected; read it again before resolving`,
    );
  }

  const lease = await sends.acquireLease(env.DB, sendId, now, LEASE_TTL_MS);
  if (!lease) {
    // It changed between the checks and the lease: answer for what it is now (another
    // Resolve may have finished it), carrying the send as it now stands.
    const current = await sends.getSend(env.DB, sendId);
    if (current && guard.ifMatch !== undefined && current.rev !== guard.ifMatch) {
      throw await refuse(
        412,
        "precondition_failed",
        `the send has changed since rev ${guard.ifMatch} (it is at rev ${current.rev}); read it again before resolving`,
      );
    }
    if (!current || !isWedged(current)) {
      throw await refuse(409, "not_wedged", "send is no longer wedged");
    }
    throw await refuse(
      409,
      "run_in_progress",
      "this send is being worked on right now; try Resolve again in a moment",
    );
  }
  const note =
    outcome === "unsent"
      ? `operator adjudication: assumed NOT delivered (${actor})`
      : `operator adjudication: assumed delivered (${actor})`;
  const resolved = await sends.resolveDispatched(env.DB, sendId, lease, outcome, note, now);

  // Run the loop's completion gate: finish only when nothing is left in flight, so a
  // send that still has pending rows just continues when the sweep next resumes it: the
  // next tick, or a halted send's next retry.
  const pending = await sends.countDeliveries(env.DB, sendId, "pending");
  const stillDispatched = await sends.countDeliveries(env.DB, sendId, "dispatched");
  let completed = false;
  if (pending === 0 && stillDispatched === 0) {
    await sends.completeSend(env.DB, sendId, send.post_id, now, lease);
    completed = true;
  } else {
    await sends.releaseLease(env.DB, sendId, lease);
  }

  return { resolved, completed };
}
