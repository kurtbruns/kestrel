/**
 * A sweep tick's clock for the send path (SPEC §6): when to stop starting work, and the
 * pace a provider's requests keep. One is shared by every send a tick runs, so two sends
 * in one tick neither outlast it into the next nor together exceed the provider's rate.
 *
 * It reads `performance.now()`, which on Workers advances with I/O as `Date` does, but
 * which the specs leave running while they fake `Date`, so pacing and the deadline keep
 * real time there too.
 */

/** How long a tick keeps starting requests, so the rest waits for the next tick rather
 *  than running into it: the cron fires every minute, and the last requests need a
 *  moment to be answered and recorded. */
export const TICK_WINDOW_MS = 50 * 1000;

export class SendWindow {
  /** When the tick stops starting requests, on the `performance.now()` clock. */
  readonly deadline: number;
  /** The least time between two request starts; zero for a provider with no rate. */
  private readonly gap: number;
  /** The earliest the next request may start. */
  private next = 0;

  /** `rate` is the provider's most requests a second, if it has one. */
  constructor(rate: number | undefined, windowMs = TICK_WINDOW_MS) {
    this.deadline = performance.now() + windowMs;
    this.gap = rate ? 1000 / rate : 0;
  }

  /** How many more requests can start before the deadline at this pace, counting the
   *  ones already waiting to start. */
  startsLeft(): number {
    const first = Math.max(performance.now(), this.next);
    if (first > this.deadline) {
      return 0;
    }
    return this.gap === 0
      ? Number.POSITIVE_INFINITY
      : Math.floor((this.deadline - first) / this.gap) + 1;
  }

  /** Wait until the next request may start, and reserve its start. Starts are reserved
   *  in call order, so requests begun together still go out one gap apart. */
  async pace(): Promise<void> {
    if (this.gap === 0) {
      return;
    }
    const now = performance.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) {
      await new Promise((resolve) => setTimeout(resolve, at - now));
    }
  }
}
