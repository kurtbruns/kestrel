/*
 * The local send sweep, on production's schedule.
 *
 * Deployed, a Cron Trigger (`* * * * *` in wrangler.jsonc) runs the send sweep once a
 * minute, on the minute: it fires due sends, resumes interrupted and halted ones, and (in
 * dev) settles simulated receipts. `wrangler dev` never fires a cron on its own; it only
 * exposes a URL that runs the scheduled handler once. Without something calling it, a local
 * send scheduled for 10:05 is never sent, a paused send never resumes, and a record never
 * settles.
 *
 * `startSweepTicker` calls that URL at every wall-clock minute, so a local send fires,
 * resumes, and settles when a deployed one would: a send scheduled a minute out fires one to
 * two minutes later, and a halted send waits out its backoff as it would deployed.
 * `scripts/dev.mjs` starts it beside wrangler. `triggerSweep` is one extra tick on demand,
 * for a dev tool that wants a demo send to fire the moment it comes due (an extra tick, the
 * same handler: nothing about how the app behaves changes).
 */

/** The path `wrangler dev` answers by running the Worker's scheduled handler once. */
const SCHEDULED_PATH = "/cdn-cgi/local/scheduled";
const MINUTE = 60_000;

/**
 * Run the scheduled handler once on the dev server at `base`, as the cron would at `time`.
 * Resolves true when the handler ran, false when the server isn't answering yet.
 */
export async function triggerSweep(base, time = Date.now()) {
  const url = new URL(SCHEDULED_PATH, base);
  url.searchParams.set("cron", "* * * * *");
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
 * Call the sweep at the top of every minute until stopped. A tick that fails because the
 * server is still starting (or restarting on a Worker edit) is skipped quietly, as a
 * deployed tick would simply come round again; any other failure is logged once. Returns
 * a function that stops it.
 */
export function startSweepTicker(base, log = console) {
  let timer;
  let stopped = false;
  let announced = false;
  let warned = false;
  const schedule = () => {
    const now = Date.now();
    timer = setTimeout(tick, MINUTE - (now % MINUTE));
  };
  const tick = async () => {
    if (stopped) {
      return;
    }
    // The next tick is scheduled first, so a slow sweep can't push the one after it off the
    // minute: deployed, ticks don't wait for each other either (the lease keeps them apart).
    schedule();
    const scheduledTime = Date.now() - (Date.now() % MINUTE);
    const ok = await triggerSweep(base, scheduledTime);
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
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
