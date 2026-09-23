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
/** How far back a finished or late send is still news: the sweep records a notification
 *  only for one that finished or fired within this, so the first tick after notifications
 *  are set up never mails the publisher about the whole history. */
export const NOTIFY_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Tries a notification gets before it is recorded failed (one a tick). */
export const MAX_NOTIFY_ATTEMPTS = 5;
/** Per-recipient retry cap before a delivery is marked unsent so the send can complete. */
export const MAX_DELIVERY_ATTEMPTS = 5;

// --- subscribing (SPEC §7) ---
/** At most one confirmation per address in this long, however often it is subscribed, so
 *  the public form can't be used to flood a stranger's inbox. */
export const CONFIRM_COOLDOWN_MS = 15 * 60 * 1000;
/** How long a confirmation link stays good after it was sent. An older one offers to send
 *  a fresh link instead, so a months-old email can't record consent. */
export const CONFIRM_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const now = (): number => Date.now();
