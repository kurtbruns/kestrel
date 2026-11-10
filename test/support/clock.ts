/**
 * The sweep's clock, for specs that run it with `Date` faked. The sweep leaves a halted
 * send alone until its backoff is due (SPEC §12), so a spec that sweeps back to back would
 * never see the retry; these move the clock the way the cron and the backoff would.
 */
import { vi } from "vitest";

/** The earliest retry any halted send is waiting for, or null if none is. */
export async function nextRetry(db: D1Database): Promise<number | null> {
  return db
    .prepare("SELECT MIN(halt_retry_at) AS at FROM sends WHERE status = 'sending'")
    .first<number | null>("at");
}

/** Move the clock to the next sweep tick: a minute on, as the cron would, or on to the next
 *  halt retry when that is later, so the tick after a halt is its retry. */
export async function toNextTick(db: D1Database): Promise<void> {
  vi.setSystemTime(Math.max(Date.now() + 60_000, (await nextRetry(db)) ?? 0));
}

/**
 * A clock for the pacing (`performance.now()`, which the account check's reads and a send's
 * batches are spaced on) that moves by a timer's delay when the timer fires, with the wait
 * itself skipped, so code that doesn't wait for its timer sees no time pass. A gap between two
 * reads is then exactly what the code waited: a measured one would also count how late a loaded
 * machine woke the test and how long a read took, and the reads, a second apart, would cost real
 * time. Every `setTimeout` in the isolate moves it, which the exact gaps below rely on the
 * account check's path having only its pacing timer for (its request timeout is an
 * `AbortSignal`), so a new timer on that path shows up there as a wrong gap.
 */
export function pacedClock(): { readonly now: number } {
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms = 0) =>
    realSetTimeout(() => {
      clock.now += ms;
      run();
    }, 0)) as typeof setTimeout);
  return clock;
}
