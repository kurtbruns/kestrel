/**
 * Recognizes a D1 stall: a statement that hangs for seconds and then fails with an internal
 * error, where the next statement a minute later runs clean. What a stall logs depends on
 * whether the next sweep tick makes up for what it interrupted (SPEC §12):
 *
 *   - `d1.unavailable` at warn, with `during` saying where, because the next tick starts that
 *     work over from the record: `sweep` (the tick's own reads and checks, which also don't
 *     rethrow, so the invocation shows no exception), `receipts` (applying held receipts, which
 *     stay held), `notify` (telling the publisher), and `account` (the account check).
 *   - An error, because the next tick doesn't make up for it: `send.error` (it can leave
 *     recipients waiting on Resolve), `sending.record_failed` (the provider's answer is gone,
 *     and nothing asks again), and whatever a request logs (no tick answers it again).
 *   - A warning of its own, because the work goes ahead without what it read:
 *     `provider.pacing_unread` (the send keeps to the deployment's own rate) and
 *     `schema.unchecked`.
 *
 * `d1.unavailable` every minute means that work isn't getting done. With `during: sweep` the
 * database is probably down, so no send fires and no notification goes out. With any other
 * value that step alone may be failing, and sends can still go out.
 *
 * A failure's `stack`, on the lines the sweep logs, shows the `db/` function that awaited the
 * failed statement. A frame survives the round trip only across an await, so for a function that
 * returns the statement's promise unawaited (`getSend`, say) it shows the caller instead.
 */

import { errorText } from "./log";

// D1's words up to the reference that varies. Exact and anchored on purpose: a failure this
// misses, wording Cloudflare changes later included, stays at error, so a miss costs an extra
// alarm and never hides a failure.
const STALL = "D1_ERROR: internal error; reference = ";

/** Whether a thrown value is D1's report of a stall. */
export function isD1Stall(err: unknown): boolean {
  return errorText(err).startsWith(STALL);
}
