/**
 * A provider outage past an hour (SPEC §8, §12): a send still retried that has met the
 * provider unavailable at every retry of its backoff (`LONG_OUTAGE_HALTS`). The watch's
 * reading, which the notifier checks before it tells; `recordNotifications` holds the same
 * test as SQL.
 */

import type { SendRow } from "../db/sends";
import { LONG_OUTAGE_HALTS } from "../lib/time";
import { isWedged } from "./wedged";

/** Sending, unavailable for `LONG_OUTAGE_HALTS` halts in a row, and not wedged: a wedged send
 *  is no longer retried, whatever halt it last carried, so it waits on Resolve instead. */
export function isLongOutage(
  send: Pick<
    SendRow,
    "halt_reason" | "halt_retries" | "c_pending" | "c_in_flight" | "locked_until"
  > & { status: string },
): boolean {
  return (
    send.status === "sending" &&
    send.halt_reason === "unavailable" &&
    send.halt_retries >= LONG_OUTAGE_HALTS &&
    !isWedged(send)
  );
}
