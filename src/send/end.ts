/**
 * The publisher's End of a send that is held or wedged (SPEC §12): the way out for a send that
 * will never clear, such as one an account suspended for good holds, or a post no longer
 * timely after a long outage.
 *
 * The app never ends a send; only a person does, and only one that carries a halt (a refusal
 * or an outage) or is wedged (`isEndable`), never one still moving, since stopping that would
 * be a pause, which stays deferred. Ending records everyone not yet handed off as unsent by the
 * publisher's decision, settles anyone whose fate is unknown as Resolve would (the same
 * assume-sent or assume-not-sent choice, in the same step), and finishes the send and its post
 * as a completed send finishes. It only narrows the audience (I1), mails no one (I4), and
 * touches no recipient the provider took, whose receipts still land. It holds the send's lease
 * while it works, as Resolve does, and is refused while a run holds it.
 */

import type { WedgedResolution } from "../../shared/sends";
import type { Actor } from "../../shared/who_acted";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { fieldError } from "../lib/body";
import { notFound, refusal } from "../lib/errors";
import { log, whoActed } from "../lib/log";
import { LEASE_TTL_MS } from "../lib/time";
import { sendAsItStands } from "./describe";
import { isEndable, runHolds } from "./endable";
import { resolutionNote } from "./resolve";

// Why a send that isn't sending can't be ended, in words rather than its status name.
const NOT_SENDING: Record<Exclude<sends.SendStatus, "sending">, string> = {
  scheduled: "hasn’t started: cancel it instead",
  sent: "has finished",
  canceled: "was canceled",
};

const RUN_IN_PROGRESS = "This send is being worked on right now. Try ending it again in a moment.";

/** What an End did: how many recipients in flight it settled, and how many still waiting to be
 *  handed off it recorded unsent. The route answers with the send as it now stands beside these. */
export interface EndResult {
  resolved: number;
  unsent: number;
}

/**
 * End a held or wedged send. `resolution` is the publisher's answer for the recipients in
 * flight, whose fate is unknown: required when there are any, and refused when there are none,
 * each as a 400 naming the field. Refused, each with its own code and the send as it stands:
 * `run_in_progress` while a run holds it, and `not_held` when it is neither held nor wedged
 * (still moving, or not sending at all). `by` is recorded on the send as who ended it (SPEC §11),
 * and named in each settled row's note.
 */
export async function endSendAsked(
  env: AppEnv,
  sendId: string,
  resolution: WedgedResolution | null,
  by: Actor,
): Promise<EndResult> {
  const send = await sends.getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const refuse = async (code: "run_in_progress" | "not_held", message: string) =>
    refusal(code, message, await sendAsItStands(env, send.id));
  const notHeld = (s: sends.SendRow) =>
    refuse(
      "not_held",
      s.status === "sending"
        ? "This send is still going out, so there’s nothing to end: only a send held by the provider, or waiting for Resolve, can be ended."
        : `This send ${NOT_SENDING[s.status]}, so there’s nothing to end.`,
    );
  const now = Date.now();
  if (send.status === "sending" && runHolds(send, now)) {
    throw await refuse("run_in_progress", RUN_IN_PROGRESS);
  }
  if (!isEndable(send)) {
    throw await notHeld(send);
  }

  const lease = await sends.acquireLease(env.DB, sendId, now, LEASE_TTL_MS);
  if (!lease) {
    // It changed between the checks and the lease: answer for what it is now (another End
    // may have finished it).
    const current = await sends.getSend(env.DB, sendId);
    if (!current || !isEndable(current)) {
      throw await notHeld(current ?? send);
    }
    throw await refuse("run_in_progress", RUN_IN_PROGRESS);
  }
  // Read again under the lease: no run can move it now, so what it holds is what the End
  // settles. A halt can only be cleared by a run, so it is still endable. It is read as if no
  // run held it, since the only lease on it now is this End's own.
  const held = await sends.getSend(env.DB, sendId);
  if (!held || !isEndable({ ...held, locked_until: null })) {
    await sends.releaseLease(env.DB, sendId, lease);
    throw await notHeld(held ?? send);
  }
  const inFlight = await sends.countDeliveries(env.DB, sendId, "dispatched");
  if (inFlight > 0 && resolution === null) {
    await sends.releaseLease(env.DB, sendId, lease);
    throw fieldError(
      "resolution",
      `resolution is required: ${inFlight} recipient${inFlight === 1 ? "’s" : "s’"} fate is unknown, so say whether to assume they were sent ('accepted') or not ('unsent')`,
    );
  }
  if (inFlight === 0 && resolution !== null) {
    await sends.releaseLease(env.DB, sendId, lease);
    throw fieldError(
      "resolution",
      "resolution is only for recipients whose fate is unknown, and this send has none: leave it out",
    );
  }
  // A send held before its first hand-off has fixed no audience yet: fix it now, as that first
  // hand-off would have, so the record lists everyone this send was for, each recorded unsent.
  // It reads the list as it stands, never widening a fixed audience (I1).
  if (held.audience_resolved_at === null) {
    await sends.resolveAudience(env.DB, sendId, now);
  }

  const settle = resolution ? { resolution, note: resolutionNote(resolution, by) } : null;
  const { resolved, unsent } = await sends.endSend(env.DB, held, lease, settle, now, by);
  // At warn: a person's call that leaves recipients without this post (SPEC §12's level rule).
  log.warn("send.ended", {
    sendId,
    postId: held.post_id,
    resolution,
    resolved,
    unsent,
    ...whoActed(by),
  });
  return { resolved, unsent };
}
