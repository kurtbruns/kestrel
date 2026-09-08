/**
 * The idempotent, resumable send loop (I1, I2, I4). Only the sweep calls it.
 *
 * `deliveries` is both the work queue and the idempotency ledger. A recipient is
 * only ever selected while `pending`; we flip it to `dispatched` BEFORE the
 * network call and to `accepted`/`failed` after, so a crash can never re-mail an
 * accepted recipient. Each invocation attempts each recipient at most once;
 * retryables go back to `pending` and wait for the next sweep tick (the backoff).
 */
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { LEASE_TTL_MS, MAX_DELIVERY_ATTEMPTS } from "../lib/time";
import { getProvider } from "../providers";
import type { Recipient } from "../providers/types";
import * as sends from "../db/sends";

export interface SendLoopResult {
  sendId: string;
  leased: boolean;
  accepted: number;
  skipped: number;
  failed: number;
  requeued: number;
  finished: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runSend(env: AppEnv, sendId: string): Promise<SendLoopResult> {
  const empty: SendLoopResult = {
    sendId,
    leased: false,
    accepted: 0,
    skipped: 0,
    failed: 0,
    requeued: 0,
    finished: false,
  };

  const send = await sends.getSend(env.DB, sendId);
  if (!send) return empty;

  const config = getConfig(env);
  const provider = getProvider(config, env);
  const now = Date.now();

  // Acquire the lease (also moves scheduled -> sending). If we don't win, no-op.
  const leased = await sends.acquireLease(env.DB, sendId, now, LEASE_TTL_MS);
  if (!leased) return empty;

  // A prior invocation may have left in-flight rows. For idempotent providers it
  // is safe to re-send them (deduped by key); otherwise leave them for a human.
  if (provider.idempotentRetry) {
    await sends.resetDispatchedToPending(env.DB, sendId, now);
  }

  // Resolve the audience once (idempotent), then work the snapshot of pending rows.
  await sends.materializeAudience(env.DB, sendId, now);

  const result: SendLoopResult = { ...empty, leased: true };
  const batchSize = Math.min(provider.maxBatch, 500);
  const pendingIds = await sends.pendingDeliveryIds(env.DB, sendId);

  for (const ids of chunk(pendingIds, batchSize)) {
    await sends.renewLease(env.DB, sendId, Date.now() + LEASE_TTL_MS);
    const work = await sends.fetchDeliveryWork(env.DB, ids);

    // Honor unsubscribe/suppression at the last moment (I2), and cap retries.
    const live: { id: string; email: string; token: string }[] = [];
    const t = Date.now();
    for (const d of work) {
      if (d.sub_status !== "confirmed" || d.suppressed || !d.token) {
        await sends.setDeliverySkipped(env.DB, d.id, t);
        result.skipped += 1;
      } else if (d.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await sends.setDeliveryFailed(env.DB, d.id, "max attempts exceeded", t);
        result.failed += 1;
      } else {
        live.push({ id: d.id, email: d.email, token: d.token });
      }
    }
    if (live.length === 0) continue;

    // Phase 1: record intent before the network call.
    await sends.setDeliveriesDispatched(env.DB, live.map((l) => l.id), Date.now());

    const recipients: Recipient[] = live.map((l) => ({
      email: l.email,
      unsubscribeUrl: `${config.appOrigin}/unsubscribe?token=${l.token}`,
    }));
    const byEmail = new Map(live.map((l) => [l.email, l.id]));

    let results;
    try {
      results = await provider.sendBatch(
        { subject: send.subject, html: send.rendered_html, text: send.rendered_text },
        recipients,
        { idempotencyKeyPrefix: sendId },
      );
    } catch (err) {
      // Whole-batch failure (transient). For idempotent providers, requeue for
      // the next tick; otherwise leave dispatched (ambiguous) for the sweep to flag.
      const t2 = Date.now();
      if (provider.idempotentRetry) {
        for (const l of live) {
          await sends.requeueDelivery(env.DB, l.id, String((err as Error).message ?? err), t2);
          result.requeued += 1;
        }
      }
      await sends.releaseLease(env.DB, sendId);
      return result;
    }

    // Phase 2: record outcomes.
    const t3 = Date.now();
    for (const r of results) {
      const id = byEmail.get(r.email);
      if (!id) continue;
      if (r.accepted) {
        await sends.setDeliveryAccepted(env.DB, id, r.providerId, t3);
        result.accepted += 1;
      } else if (r.retryable) {
        await sends.requeueDelivery(env.DB, id, r.error, t3);
        result.requeued += 1;
      } else {
        await sends.setDeliveryFailed(env.DB, id, r.error, t3);
        result.failed += 1;
      }
    }
  }

  // Complete, or leave it for the next tick to resume.
  const pending = await sends.countDeliveries(env.DB, sendId, "pending");
  const dispatched = await sends.countDeliveries(env.DB, sendId, "dispatched");
  if (pending === 0 && dispatched === 0) {
    await sends.completeSend(env.DB, sendId, send.post_id, Date.now());
    result.finished = true;
  } else {
    await sends.releaseLease(env.DB, sendId);
  }
  return result;
}
