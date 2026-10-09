/*
 * The local send sweep, on production's schedule, and the simulated receipts on theirs.
 *
 * Deployed, a Cron Trigger (`* * * * *` in wrangler.jsonc) runs the send sweep once a
 * minute, on the minute: it fires due sends and resumes interrupted and halted ones.
 * `wrangler dev` never fires a cron on its own; it only exposes a URL that runs the
 * scheduled handler once. Without something calling it, a local send scheduled for 10:05 is
 * never sent and a paused send never resumes.
 *
 * `startSweepTicker` calls that URL at every wall-clock minute, so a local send fires and
 * resumes when a deployed one would: a send scheduled a minute out fires one to two minutes
 * later, and a halted send waits out its backoff as it would deployed. Every few seconds it
 * also calls it with the receipts cron, which the Worker reads as "settle the simulated
 * receipts that have come due, and nothing else": deployed, a provider's webhooks arrive
 * whenever they arrive, whether or not anyone is looking, and so do these (SPEC §10), rather
 * than in minute steps or only while a page reads. `scripts/dev.mjs` starts it beside
 * wrangler. `triggerSweep` is one extra tick on demand, for a dev tool that wants a demo send
 * to fire the moment it comes due (an extra tick, the same handler: nothing about how the
 * app behaves changes).
 */

/** The path `wrangler dev` answers by running the Worker's scheduled handler once. */
const SCHEDULED_PATH = "/cdn-cgi/local/scheduled";
const MINUTE = 60_000;

/** The deployed sweep's cron (wrangler.jsonc's trigger). */
const SWEEP_CRON = "* * * * *";

/** The cron value the Worker reads as "settle simulated receipts only": `RECEIPTS_CRON` in
 *  src/providers/simulate.ts, which a Worker spec pins to this one. Not a cron expression,
 *  so no deployed trigger can carry it. */
const RECEIPTS_CRON = "dev:receipts";

/** How often simulated receipts are settled: a receipt lands within a couple of seconds of
 *  coming due, near enough to a webhook arriving the moment the provider sends it. */
const RECEIPTS_MS = 2_000;

/** Run the scheduled handler once on the dev server at `base`, with `cron` as its trigger. */
async function runScheduled(base, cron, time) {
  const url = new URL(SCHEDULED_PATH, base);
  url.searchParams.set("cron", cron);
  url.searchParams.set("time", String(time));
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run the scheduled handler once on the dev server at `base`, as the cron would at `time`.
 * Resolves true when the handler ran, false when the server isn't answering yet.
 */
export function triggerSweep(base, time = Date.now()) {
  return runScheduled(base, SWEEP_CRON, time);
}

/**
 * Call the sweep at the top of every minute, and settle simulated receipts every
 * `RECEIPTS_MS`, until stopped. A tick that fails because the server is still starting (or
 * restarting on a Worker edit) is skipped quietly, as a deployed tick would simply come
 * round again; any other failure is logged once. Returns a function that stops both.
 */
export function startSweepTicker(base, log = console) {
  let timer;
  let receipts;
  let stopped = false;
  let announced = false;
  let warned = false;
  const schedule = () => {
    const now = Date.now();
    const minute = now - (now % MINUTE) + MINUTE;
    timer = setTimeout(() => tick(minute), minute - now);
  };
  // `minute` is the one the tick was set for, as a deployed cron's `scheduledTime` is.
  const tick = async (minute) => {
    if (stopped) {
      return;
    }
    // A timer can fire before the minute it was set for: it runs on a monotonic clock, the
    // minute is wall-clock, and the two drift or step apart. A deployed cron never runs early,
    // and an early sweep would miss a send due on the minute (the editor schedules on whole
    // minutes), so wait out the rest of it. The next tick is then a full minute away.
    const early = minute - Date.now();
    if (early > 0) {
      timer = setTimeout(() => tick(minute), early);
      return;
    }
    // The next tick is scheduled first, so a slow sweep can't push the one after it off the
    // minute: deployed, ticks don't wait for each other either (the lease keeps them apart).
    schedule();
    const ok = await triggerSweep(base, minute);
    if (ok && !announced) {
      announced = true;
      log.log("[dev] send sweep: running once a minute, on the minute, as the deployed cron does");
    } else if (!ok && announced && !warned) {
      warned = true;
      log.warn(
        `[dev] send sweep: a tick got no answer from ${base} (the server may be restarting)`,
      );
    }
  };
  // Each receipts tick waits for the last to finish, so a slow one never stacks up behind
  // itself. A no-op in the Worker unless the send simulation is on.
  const settleReceipts = async () => {
    if (stopped) {
      return;
    }
    await runScheduled(base, RECEIPTS_CRON, Date.now());
    if (!stopped) {
      receipts = setTimeout(settleReceipts, RECEIPTS_MS);
    }
  };
  schedule();
  receipts = setTimeout(settleReceipts, RECEIPTS_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(receipts);
  };
}
