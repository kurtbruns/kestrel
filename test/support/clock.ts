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
