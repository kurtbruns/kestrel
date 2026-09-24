/**
 * Wedged (SPEC §12): a send that cannot finish until the publisher resolves recipients
 * whose fate is unknown. The watch's reading of `WEDGED_SEND` (`db/sends.ts`), the one
 * definition, which the feed, the sweep, and the notifications read as SQL; the two are
 * pinned to agree by `test/send_wedged.spec.ts`.
 */

import type { SendRow } from "../db/sends";

/** Sending, nothing left to hand off, recipients in flight, and the lease released by the
 *  run that left them there. */
export function isWedged(
  send: Pick<SendRow, "c_pending" | "c_in_flight" | "locked_until"> & { status: string },
): boolean {
  return (
    send.status === "sending" &&
    send.c_pending === 0 &&
    send.c_in_flight > 0 &&
    send.locked_until === null
  );
}
