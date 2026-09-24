/**
 * When a follower of `GET /sends/feed` should read again (SPEC §8): the server owns the
 * pace, so every client, the editor and Claude alike, keeps up with sends the same way
 * without rebuilding the rule.
 *
 * The pace follows what can change on its own. A due or sending send can move at any
 * sweep tick, so it is read every few seconds. A settling send's receipts arrive fastest
 * just after dispatch, so the pace eases by the youngest one's age. Otherwise nothing
 * moves without someone acting, and a read about once a minute (one sweep tick) is enough
 * for a change the other client made to show. A read never waits past the next fire time.
 *
 * The pace only bounds how late a change shows, never whether it does: the feed reports
 * every send that changed after the follower's cursor, so a read that comes late loses
 * nothing.
 */

// While a send is due or sending, the sweep can act on it at any minute's tick.
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

// A read for a fire time lands this long after it, so the server's clock has passed it.
const WAKE_SLACK_MS = 1000;

/** What sets the pace: whether any send is sending or due (short of the missed tolerance:
 *  a missed send waits on a sweep that isn't running, so it moves nothing), when the
 *  youngest settling send finished dispatch, and the soonest fire time still ahead. */
export interface FeedPace {
  active: boolean;
  settlingSince: number | null;
  nextFireAt: number | null;
}

/** When to read the feed again, by the server's clock. */
export function readAgainAt(pace: FeedPace, now: number): number {
  let wait = IDLE_MS;
  if (pace.active) {
    wait = FOLLOW_MS;
  } else if (pace.settlingSince !== null) {
    const age = now - pace.settlingSince;
    wait = SETTLE_PACE.find((p) => age < p.within)?.every ?? IDLE_MS;
  }
  const at = now + wait;
  return pace.nextFireAt === null ? at : Math.min(at, pace.nextFireAt + WAKE_SLACK_MS);
}
