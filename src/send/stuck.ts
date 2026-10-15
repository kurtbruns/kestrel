/**
 * In flight too long (SPEC §12): a send that has handed off no one for the stuck threshold
 * with nothing else to explain it. The watch's reading of `SEND_IDLE_SINCE` and
 * `stuckSendSql` (`db/sends.ts`), the one definition, which the feed, the sweep, and the
 * notifications read as SQL; the two are pinned to agree by `test/send_stuck.spec.ts`.
 *
 * Progress, not duration, is what counts: a large send at a slow provider rate goes out
 * for hours and is fine. A halt explains the wait until its next retry, and a wedged send
 * waits for Resolve, so neither is stuck; what is left is a send nothing is moving, such as
 * a sweep that stopped mid-send or a run that fails every tick.
 */

import { STUCK_THRESHOLD_MS } from "../../shared/sends";
import type { SendRow } from "../db/sends";
import { isWedged } from "./wedged";

type Idle = Pick<
  SendRow,
  "started_at" | "progress_at" | "halt_retry_at" | "c_pending" | "c_in_flight" | "locked_until"
> & { status: string };

/** Since when the send has been idle with nothing to explain it: its last progress (its
 *  start before the first), or a halt's next retry if later. Null when it is not sending,
 *  or is wedged. */
export function idleSince(send: Idle): number | null {
  if (send.status !== "sending" || send.started_at === null || isWedged(send)) {
    return null;
  }
  return Math.max(send.progress_at ?? send.started_at, send.halt_retry_at ?? 0);
}

/** When the send turns in flight too long if nothing moves it first; null when it can't. */
export function stuckAt(send: Idle): number | null {
  const idle = idleSince(send);
  return idle === null ? null : idle + STUCK_THRESHOLD_MS;
}

/** Whether the send is in flight too long at `now`. */
export function isStuck(send: Idle, now: number): boolean {
  const at = stuckAt(send);
  return at !== null && now > at;
}
