/** Timing constants for scheduling and (in M6) the sweep. */

/**
 * The minimum cancelable review window (I6). "Send now" fires at now + this, and
 * scheduling requires fire_at to be at least this far out — so EVERY send, however
 * requested, spends at least this long as a visible, cancelable Send before any
 * mail leaves. There is no path that fires the instant it's requested.
 */
export const SEND_NOW_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// --- send loop / sweep (M6) ---
/** How long a runSend holds its lease before another tick may resume the send. */
export const LEASE_TTL_MS = 5 * 60 * 1000;
/** A scheduled send later than this past its fire time is flagged MISSED_FIRE (still delivered). */
export const MISSED_THRESHOLD_MS = 5 * 60 * 1000;
/** A send stuck in `sending` longer than this is flagged STUCK_SEND. */
export const STUCK_THRESHOLD_MS = 30 * 60 * 1000;
/** Per-recipient retry cap before a delivery is marked failed so the send can complete. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export const now = (): number => Date.now();
