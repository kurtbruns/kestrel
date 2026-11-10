/**
 * Which sends the publisher may end (SPEC §12): one held on a halt (a refusal or an outage)
 * or wedged on recipients whose fate is unknown, never one still moving, since stopping a
 * send that is handing off would be a pause, which stays deferred. The one definition: the
 * actions a send offers and the End itself read it.
 */

import type { SendRow } from "../db/sends";
import { isWedged } from "./wedged";

type EndableFields = Pick<SendRow, "c_pending" | "c_in_flight" | "locked_until"> & {
  status: string;
  halt_reason: string | null;
};

/** Sending, and either carrying a halt or wedged. */
export function isEndable(send: EndableFields): boolean {
  return send.status === "sending" && (send.halt_reason !== null || isWedged(send));
}

/** A run holds the send's lease at `now`: an End waits for it, as Resolve does. */
export function runHolds(send: Pick<SendRow, "locked_until">, now: number): boolean {
  return send.locked_until !== null && send.locked_until > now;
}
