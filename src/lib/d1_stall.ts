/**
 * Recognizes a D1 stall: a statement that hangs for seconds and then fails with an internal
 * error, where the next statement a minute later runs clean. The sweep logs one as a warning
 * rather than an error (SPEC §12).
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
