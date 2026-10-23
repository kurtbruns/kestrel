/**
 * Operator adjudication of a wedged send (SPEC §12).
 *
 * A mid-batch transport error — the request left but no response came back —
 * leaves its recipients `dispatched`:
 * genuinely ambiguous, because we cannot know whether the provider accepted them.
 * The send loop deliberately refuses to blind-retry those rows (that refusal is
 * what protects I4, since no provider dedupes a repeat), so the send can never
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

import type { SendStatus, WedgedResolution } from "../../shared/sends";
import type { Actor } from "../../shared/who_acted";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { notFound, refusal } from "../lib/errors";
import { log, whoActed } from "../lib/log";
import { LEASE_TTL_MS } from "../lib/time";
import { sendAsItStands } from "./describe";
import { isWedged } from "./wedged";

// The resolution lives in shared/ so the editor reads the same definition.
export type { WedgedResolution };

// Why a send that isn't sending has nothing to resolve, in words rather than its status name.
const NOT_SENDING: Record<Exclude<SendStatus, "sending">, string> = {
  scheduled: "hasn’t started",
  sent: "has finished",
  canceled: "was canceled",
};

/** What a Resolve did: how many ambiguous recipients it settled, and whether the send
 *  then finished. The route answers with the send as it now stands beside these. */
export interface ResolveResult {
  resolved: number;
  completed: boolean;
}

/**
 * Adjudicate the ambiguous (`dispatched`) rows of a wedged send. Refused, each with its
 * own code and the send as it stands: `run_in_progress` while a run holds it, and
 * `not_wedged` when it is not wedged (`isWedged`: nothing to resolve, or a run still to
 * look at it). It names no count or `rev` the caller read: once a send is wedged no run
 * touches it, so its ambiguous set holds until a Resolve settles it, and a second Resolve
 * finds it no longer wedged. `by` is recorded on the send as who resolved it (SPEC §11), and
 * named in each settled row's note.
 */
export async function resolveStuckSend(
  env: AppEnv,
  sendId: string,
  outcome: WedgedResolution,
  by: Actor,
): Promise<ResolveResult> {
  const send = await sends.getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const refuse = async (code: "run_in_progress" | "not_wedged", message: string) =>
    refusal(code, message, await sendAsItStands(env, send.id));
  const now = Date.now();
  if (send.status === "sending" && send.locked_until !== null && send.locked_until > now) {
    throw await refuse(
      "run_in_progress",
      "This send is being worked on right now. Try Resolve again in a moment.",
    );
  }
  if (!isWedged(send)) {
    throw await refuse(
      "not_wedged",
      send.status === "sending"
        ? "Nothing on this send needs resolving: it still has recipients to hand off, or a run has yet to look at those in flight."
        : `This send ${NOT_SENDING[send.status]}, so there’s nothing to resolve.`,
    );
  }

  const lease = await sends.acquireLease(env.DB, sendId, now, LEASE_TTL_MS);
  if (!lease) {
    // It changed between the checks and the lease: answer for what it is now (another
    // Resolve may have finished it), carrying the send as it now stands.
    const current = await sends.getSend(env.DB, sendId);
    if (!current || !isWedged(current)) {
      throw await refuse("not_wedged", "Nothing on this send needs resolving any more.");
    }
    throw await refuse(
      "run_in_progress",
      "This send is being worked on right now. Try Resolve again in a moment.",
    );
  }
  const note =
    outcome === "unsent"
      ? `operator adjudication: assumed NOT delivered (${noteName(by)})`
      : `operator adjudication: assumed delivered (${noteName(by)})`;
  const resolved = await sends.resolveDispatched(env.DB, sendId, lease, outcome, note, now, by);

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
  // At warn: a person's manual call on recipients whose fate was unknown (SPEC §12's level rule).
  log.warn("send.resolved", {
    sendId,
    postId: send.post_id,
    resolution: outcome,
    resolved,
    completed,
    ...whoActed(by),
  });

  return { resolved, completed };
}

/** Who resolved, as each settled row's note names them: a person's email, or a service token by
 *  its name. */
function noteName(by: Actor): string {
  return by.email ?? (by.token_id ? `service ${by.token_id}` : "service");
}
