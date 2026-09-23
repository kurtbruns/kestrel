/** Timing constants for scheduling and (in M6) the sweep. */

import type { HaltReason } from "../../shared/sends";

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
/**
 * How long a halted send waits before each retry, by the reason it halted (SPEC §12): the
 * n-th halt in a row waits the n-th step, and the last step repeats for as long as the halt
 * lasts. There is no ceiling on the count, only on the wait. A rate limit or a brief outage
 * usually clears within a minute or two, so `unavailable` retries at the next tick, then
 * 3, 8, 23, and 53 minutes into the halt, then hourly: dense while a blip is likely, and
 * one request an hour once it is a real outage, which the stuck flag has raised by then. An
 * account refusal clears only when a person fixes the key, the sender, or the account (or a
 * quota resets), so each retry is a request the provider is known to refuse: `account`
 * starts at five minutes, and both cap at an hour, so a fix waits at most that long.
 */
export const HALT_BACKOFF_MS: Record<HaltReason, readonly number[]> = {
  unavailable: [1, 2, 5, 15, 30, 60].map((m) => m * 60 * 1000),
  account: [5, 15, 30, 60].map((m) => m * 60 * 1000),
};
/** Per-recipient retry cap before a delivery is marked unsent so the send can complete. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export const now = (): number => Date.now();
