/**
 * The reconciling sweep — runs once a minute from scheduled(). Four jobs:
 *   1. fire due sends (and loudly flag any that missed their fire time),
 *   2. resume sends left mid-flight by a crash (expired lease),
 *   3. flag anomalies (stuck sends, ambiguous in-flight deliveries),
 *   4. notify the publisher of sends that went out or ran into a problem (`notify/notify.ts`).
 *
 * A missed fire is still delivered — the render is frozen, so lateness is a
 * timeliness problem, not a correctness one — but it is never silent (§12).
 *
 * One tick is one invocation, so it shares one subrequest budget (`budget.ts`) across
 * its own queries and every send it runs; a send the budget can't reach this tick is
 * picked up on the next. A send the provider halted is left alone until its backoff
 * says its next retry is due (`HALT_BACKOFF_MS`), so waiting costs only the query.
 * Notifying gets what the sends leave plus a reserve held back up front, so a long send
 * spending every tick's budget can't starve the notification that says it is stuck.
 */

import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { HALT_RETRY_SLACK_MS, MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { NOTIFY_RESERVE, notifyPublisher } from "../notify/notify";
import { drainSimulatedWebhooks } from "../providers/simulate";
import { Budget, metered } from "./budget";
import { MIN_RUN_COST, runSend } from "./loop";

/** The two anomaly queries at the end of a tick, held back from the budget up front so
 *  they run whatever the sends spent. */
const ANOMALY_CHECKS = 2;

export async function sweep(env: AppEnv): Promise<void> {
  const now = Date.now();
  const config = getConfig(env);
  // Handle each send at most once per tick. A transient failure releases the
  // lease, so without this a just-failed send would be retried again in the same
  // sweep; instead it waits for the next tick (the backoff).
  const handled = new Set<string>();
  const budget = new Budget(config.subrequestBudget - ANOMALY_CHECKS - NOTIFY_RESERVE);
  const db = metered(env.DB, budget);

  // 1) Due scheduled sends.
  for (const s of await sends.dueSends(db, now)) {
    const lag = now - s.fire_at;
    if (lag > MISSED_THRESHOLD_MS) {
      console.error("MISSED_FIRE", { sendId: s.id, postId: s.post_id, lagMs: lag });
    }
    handled.add(s.id);
    await safeRun(env, s.id, budget);
  }

  // 2) Resume interrupted sends whose lease has expired (and halted ones whose next retry
  // is due), if the budget still has room
  // for one run after the query that finds them.
  const resumable = budget.affords(1 + MIN_RUN_COST)
    ? await sends.resumableSends(db, now, now + HALT_RETRY_SLACK_MS)
    : [];
  for (const s of resumable) {
    if (handled.has(s.id)) {
      continue;
    }
    handled.add(s.id);
    await safeRun(env, s.id, budget);
  }

  // 3) Loud anomaly flags: the ANOMALY_CHECKS held back above, so on the raw handle.
  for (const s of await sends.stuckSends(env.DB, now - STUCK_THRESHOLD_MS)) {
    console.error("STUCK_SEND", { sendId: s.id, postId: s.post_id, startedAt: s.started_at });
  }
  const ambiguous = await sends.staleDispatched(env.DB, now - STUCK_THRESHOLD_MS);
  if (ambiguous > 0) {
    console.error("AMBIGUOUS_DELIVERY", { count: ambiguous });
  }

  // 4) Tell the publisher: the reserve plus whatever the sends left. Last, and caught, so a
  // notification can never delay or break a send.
  try {
    await notifyPublisher(env, new Budget(NOTIFY_RESERVE + Math.max(0, budget.left)));
  } catch (err) {
    console.error("NOTIFY_ERROR", { error: String((err as Error)?.message ?? err) });
  }

  // Dev-only: feed any now-due synthetic delivery webhooks through the real ingest, so
  // an in-flight simulated send settles (delivered / bounced / complained) over ticks
  // exactly as a real provider's webhooks would. No-op unless the simulation is active.
  await drainSimulatedWebhooks(env, config);
}

async function safeRun(env: AppEnv, sendId: string, budget: Budget): Promise<void> {
  try {
    await runSend(env, sendId, budget);
  } catch (err) {
    // One bad send must not stop the sweep; it will be retried next tick.
    console.error("SEND_ERROR", { sendId, error: String((err as Error)?.message ?? err) });
  }
}
