/**
 * When a follower of `GET /sends/feed` should read again (SPEC §8): the server owns the
 * pace, so every client, the editor and Claude alike, keeps up with sends the same way
 * without rebuilding the rule.
 *
 * The pace follows what can change on its own, and when. Each send has a next change
 * (`nextChangeAt`): now, while it can move at any moment (due, or sending with work the
 * sweep can take up); a moment ahead, when it waits on the clock or the sweep (its fire
 * time, a halt's next retry, the in-flight-too-long threshold); or none, when only an
 * action or a receipt can change it (a wedged send awaiting Resolve, a missed send whose
 * sweep is not running, a finished one). While any send can move now, the feed is read
 * every few seconds. A settling send's receipts arrive fastest just after dispatch, so
 * the pace eases by the youngest one's age. Otherwise a read about once a minute (one
 * sweep tick) is enough for a change the other client made to show, and a read never
 * waits past the next change the clock or the sweep will make.
 *
 * The pace only bounds how late a change shows, never whether it does: the feed reports
 * every send that changed after the follower's cursor, so a read that comes late loses
 * nothing, and one that comes early (right after acting) costs nothing but the read.
 */

import type { SendSummary } from "../../shared/sends";
import { HALT_RETRY_SLACK_MS, MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { isWedged } from "./wedged";

// While a send can move at any moment, the sweep can act on it at any minute's tick.
const FOLLOW_MS = 3000;

/** How long after dispatch completes a settling send still quickens the pace. Some
 *  accepted messages are never confirmed at all (SPEC §6), so a send can settle
 *  indefinitely; past this, its late receipts show at the idle pace. */
export const SETTLE_FOLLOW_MS = 60 * 60 * 1000;

// While sends are only settling, the pace their receipts arrive at, by how long ago the
// youngest one finished dispatch: most land in the first minutes, stragglers over the hour.
const SETTLE_PACE: readonly { within: number; every: number }[] = [
  { within: 2 * 60_000, every: 3000 },
  { within: 10 * 60_000, every: 15_000 },
  { within: SETTLE_FOLLOW_MS, every: 60_000 },
];

// With nothing moving on its own: one sweep tick.
const IDLE_MS = 60_000;

// A read for a change the clock makes lands this long after it, so the server's clock has
// passed it.
const WAKE_SLACK_MS = 1000;

/** What of a send its next change depends on. */
export type PaceFields = Pick<
  SendSummary,
  | "status"
  | "fire_at"
  | "started_at"
  | "locked_until"
  | "halt_retry_at"
  | "c_pending"
  | "c_in_flight"
>;

/**
 * The earliest moment `send` can change with no one acting on it, by the server's clock:
 * `now` while it can move at any moment, a later time when it waits on the clock or on the
 * sweep's next retry, or null when only an action or a receipt can change it. A receipt
 * is never predicted: the settling pace covers those.
 *
 * - scheduled: its fire time; once due, now, until it is past the missed tolerance, when
 *   only a sweep that is not running can start it (null).
 * - sending with a run in hand (its lease held), or work the next tick takes up
 *   (recipients queued, or a cut-off run's lease run out, and no halt waiting): now.
 * - sending and halted: the first tick that retries it (its `halt_retry_at`, less the slack
 *   the sweep allows), or now once that has come.
 * - sending and wedged (awaiting Resolve), even with a halt left on it: only the
 *   in-flight-too-long threshold, still ahead, can change it with no one acting; a halted
 *   send crosses it too, if that comes before its retry.
 * - sent or canceled: null.
 */
export function nextChangeAt(send: PaceFields, now: number): number | null {
  if (send.status === "scheduled") {
    if (send.fire_at > now) {
      return send.fire_at;
    }
    return send.fire_at + MISSED_THRESHOLD_MS >= now ? now : null;
  }
  if (send.status !== "sending") {
    return null;
  }
  if (send.locked_until !== null && send.locked_until > now) {
    return now; // a run holds it, and may be working
  }
  let next: number | null = null;
  if (isWedged(send)) {
    // The sweep no longer runs it, whatever halt it last carried: only Resolve moves it.
  } else if (send.halt_retry_at !== null) {
    // Halted, or a run cut off after halting it: the sweep takes it up at the retry.
    next = Math.max(now, send.halt_retry_at - HALT_RETRY_SLACK_MS);
  } else {
    // Queued work, or a run cut off whose lease has run out: the next tick takes it up.
    return now;
  }
  // Wedged or halted: the in-flight-too-long threshold is the clock's change, if still ahead.
  const stuckAt = send.started_at === null ? null : send.started_at + STUCK_THRESHOLD_MS;
  if (stuckAt !== null && stuckAt >= now) {
    next = next === null ? stuckAt : Math.min(next, stuckAt);
  }
  return next;
}

/** What sets the pace, over every send that is not finished: whether one can move now,
 *  when the youngest settling send finished dispatch, and the soonest change ahead. */
export interface FeedPace {
  moving: boolean;
  settlingSince: number | null;
  nextChangeAt: number | null;
}

/** The pace over the unfinished sends (`nextChangeAt` each) and the youngest settling send. */
export function feedPace(
  sends: readonly PaceFields[],
  settlingSince: number | null,
  now: number,
): FeedPace {
  let moving = false;
  let ahead: number | null = null;
  for (const s of sends) {
    const at = nextChangeAt(s, now);
    if (at === null) {
      continue;
    }
    if (at <= now) {
      moving = true;
    } else if (ahead === null || at < ahead) {
      ahead = at;
    }
  }
  return { moving, settlingSince, nextChangeAt: ahead };
}

/** When to read the feed again, by the server's clock. */
export function readAgainAt(pace: FeedPace, now: number): number {
  let wait = IDLE_MS;
  if (pace.moving) {
    wait = FOLLOW_MS;
  } else if (pace.settlingSince !== null) {
    const age = now - pace.settlingSince;
    wait = SETTLE_PACE.find((p) => age < p.within)?.every ?? IDLE_MS;
  }
  const at = now + wait;
  return pace.nextChangeAt === null ? at : Math.min(at, pace.nextChangeAt + WAKE_SLACK_MS);
}
