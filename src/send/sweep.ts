/**
 * The reconciling sweep — runs once a minute from scheduled(). Three jobs:
 *   1. fire due sends (and loudly flag any that missed their fire time),
 *   2. resume sends left mid-flight by a crash (expired lease),
 *   3. flag anomalies (stuck sends, ambiguous in-flight deliveries).
 *
 * A missed fire is still delivered — the render is frozen, so lateness is a
 * timeliness problem, not a correctness one — but it is never silent (§14).
 */

import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { drainSimulatedWebhooks } from "../providers/simulate";
import { runSend } from "./loop";

export async function sweep(env: AppEnv): Promise<void> {
  const now = Date.now();
  const config = getConfig(env);
  // Handle each send at most once per tick. A transient failure releases the
  // lease, so without this a just-failed send would be retried again in the same
  // sweep; instead it waits for the next tick (the backoff).
  const handled = new Set<string>();

  // 1) Due scheduled sends.
  for (const s of await sends.dueSends(env.DB, now)) {
    const lag = now - s.fire_at;
    if (lag > MISSED_THRESHOLD_MS) {
      console.error("MISSED_FIRE", { sendId: s.id, postId: s.post_id, lagMs: lag });
    }
    handled.add(s.id);
    await safeRun(env, s.id);
  }

  // 2) Resume interrupted sends whose lease has expired.
  for (const s of await sends.resumableSends(env.DB, now)) {
    if (handled.has(s.id)) {
      continue;
    }
    handled.add(s.id);
    await safeRun(env, s.id);
  }

  // 3) Loud anomaly flags.
  for (const s of await sends.stuckSends(env.DB, now - STUCK_THRESHOLD_MS)) {
    console.error("STUCK_SEND", { sendId: s.id, postId: s.post_id, startedAt: s.started_at });
  }
  const ambiguous = await sends.staleDispatched(env.DB, now - STUCK_THRESHOLD_MS);
  if (ambiguous > 0) {
    console.error("AMBIGUOUS_DELIVERY", { count: ambiguous });
  }

  // Dev-only: feed any now-due synthetic delivery webhooks through the real ingest, so
  // an in-flight simulated send settles (delivered / bounced / complained) over ticks
  // exactly as a real provider's webhooks would. No-op unless the simulation is active.
  await drainSimulatedWebhooks(env, config);
}

async function safeRun(env: AppEnv, sendId: string): Promise<void> {
  try {
    await runSend(env, sendId);
  } catch (err) {
    // One bad send must not stop the sweep; it will be retried next tick.
    console.error("SEND_ERROR", { sendId, error: String((err as Error)?.message ?? err) });
  }
}
