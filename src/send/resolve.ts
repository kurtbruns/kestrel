/**
 * Operator adjudication of a wedged send (SPEC §12).
 *
 * On a non-idempotent provider (e.g. SES) a mid-batch transport error — the
 * request left but no response came back — leaves its recipients `dispatched`:
 * genuinely ambiguous, because we cannot know whether the provider accepted them.
 * The send loop deliberately refuses to blind-retry those rows (that refusal is
 * what protects I4 without a provider idempotency key), so the send can never
 * satisfy its completion gate (`pending == 0 && dispatched == 0`). It stays
 * `sending` forever, re-run on every sweep tick and flagged (`send.stuck`, `send.wedged`),
 * with no way to act on the flag but raw SQL, were it not for this.
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

import type { ResolveResponse, StuckResolution } from "../../shared/sends";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { conflict, notFound } from "../lib/errors";
import { LEASE_TTL_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";

// The shapes live in shared/ so the editor reads the same definitions; the names here
// are the Worker's own.
export type { StuckResolution };
export type ResolveResult = ResolveResponse;

/** Adjudicate the ambiguous (`dispatched`) rows of a wedged send. */
export async function resolveStuckSend(
  env: AppEnv,
  sendId: string,
  outcome: StuckResolution,
  actor: string,
): Promise<ResolveResult> {
  const send = await sends.getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  if (send.status !== "sending") {
    throw conflict("only a send in 'sending' can have ambiguous deliveries to resolve");
  }
  const dispatched = await sends.countDeliveries(env.DB, sendId, "dispatched");
  if (dispatched === 0) {
    throw conflict("send has no ambiguous (dispatched) deliveries to resolve");
  }

  const now = Date.now();
  const lease = await sends.acquireLease(env.DB, sendId, now, LEASE_TTL_MS);
  if (!lease) {
    throw conflict("this send is being worked on right now; try Resolve again in a moment");
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

  return { send: unwrap(await sends.getSend(env.DB, sendId), "send"), resolved, completed };
}
