/** Timing constants for scheduling and (in M6) the sweep. */

/**
 * The minimum cancelable review window (I6). "Send now" fires at now + this, and
 * scheduling requires fire_at to be at least this far out — so EVERY send, however
 * requested, spends at least this long as a visible, cancelable Send before any
 * mail leaves. There is no path that fires the instant it's requested.
 */
export const SEND_NOW_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export const now = (): number => Date.now();
