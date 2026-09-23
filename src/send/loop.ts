/**
 * The idempotent, resumable send loop (I1, I2, I4). Only the sweep calls it.
 *
 * `deliveries` is both the work queue and the idempotency ledger. A recipient is
 * only ever selected while `pending`; we flip it to `dispatched` BEFORE the
 * network call, under a dispatch key saved on the row, and to `accepted`/`unsent`
 * after, so a crash can never re-mail an accepted recipient. A batch whose answer
 * was never recorded is re-sent as the identical batch under its saved key, never
 * merged into a new one, so an idempotent provider dedupes it however the rest of
 * the send has changed since. Each invocation attempts each recipient at most once;
 * retryables go back to `pending` (on an idempotent provider, still under their key)
 * and wait for the next sweep tick (the backoff).
 *
 * A run spends against the invocation's subrequest budget (`budget.ts`) and stops
 * starting batches while it can still close cleanly; the next tick continues.
 */

import type { DeliveryOutcome, DeliveryWork } from "../db/sends";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { LEASE_TTL_MS, MAX_DELIVERY_ATTEMPTS } from "../lib/time";
import { getProvider } from "../providers";
import { drainSimulatedWebhooks } from "../providers/simulate";
import type { PerRecipientResult } from "../providers/types";
import { Budget, metered } from "./budget";

export interface SendLoopResult {
  sendId: string;
  leased: boolean;
  accepted: number;
  skipped: number;
  unsent: number;
  requeued: number;
  finished: boolean;
}

/** The most recipients in one batch, whatever the provider allows. */
const MAX_CHUNK = 500;

// What a run can cost, in subrequests (D1 statements plus provider requests), so it
// only starts what it can finish. Each is an upper bound; the budget counts what is
// actually spent.
/** Opening: read the send, take the lease, resolve the audience (2), list the
 *  unanswered batches and the fresh rows. */
const OPEN_COST = 6;
/** One batch: read its rows, close any no longer to be mailed (2), renew the lease,
 *  hand off (2), the provider request, record the outcomes (2). */
const CHUNK_COST = 9;
/** Closing: count what is left, then complete the send (3) or release the lease. */
const CLOSE_COST = 4;
/** The least a run needs to be worth starting. */
export const MIN_RUN_COST = OPEN_COST + CHUNK_COST + CLOSE_COST;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** A batch's recipients in one fixed order, so a re-sent batch is byte-identical. */
function byEmail(a: DeliveryWork, b: DeliveryWork): number {
  return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

export async function runSend(
  env: AppEnv,
  sendId: string,
  budget: Budget = new Budget(getConfig(env).subrequestBudget),
): Promise<SendLoopResult> {
  const empty: SendLoopResult = {
    sendId,
    leased: false,
    accepted: 0,
    skipped: 0,
    unsent: 0,
    requeued: 0,
    finished: false,
  };
  if (!budget.affords(MIN_RUN_COST)) {
    return empty;
  }
  const db = metered(env.DB, budget);

  const send = await sends.getSend(db, sendId);
  if (!send) {
    return empty;
  }

  const config = getConfig(env);
  const provider = getProvider(config, env);
  const now = Date.now();

  // Acquire the lease (also moves scheduled -> sending). If we don't win, no-op.
  const lease = await sends.acquireLease(db, sendId, now, LEASE_TTL_MS);
  if (!lease) {
    return empty;
  }
  let renewAt = now + LEASE_TTL_MS / 2;
  /** Keep the lease while the run works. False once another run holds it: it owns the
   *  send now, and this run must stop without touching it. */
  const keepLease = async (): Promise<boolean> => {
    if (Date.now() < renewAt) {
      return true;
    }
    renewAt = Date.now() + LEASE_TTL_MS / 2;
    return sends.renewLease(db, sendId, lease, Date.now() + LEASE_TTL_MS);
  };
  /** After a hand-off moved nothing: renew now, which says whether this run still owns
   *  the send or a successor took it (the moved-nothing case), and stop if it lost. */
  const stillLeased = async (): Promise<boolean> => {
    renewAt = Date.now() + LEASE_TTL_MS / 2;
    return sends.renewLease(db, sendId, lease, Date.now() + LEASE_TTL_MS);
  };
  const canStartBatch = () => budget.affords(CHUNK_COST + CLOSE_COST);

  // Resolve the audience once (idempotent), then work the snapshot of pending rows.
  await sends.materializeAudience(db, sendId, now);

  const result: SendLoopResult = { ...empty, leased: true };
  const rendered = { subject: send.subject, html: send.rendered_html, text: send.rendered_text };

  /**
   * Send one handed-off batch under its key and record the answer in one write. False
   * when the request itself failed (no answer), which ends the run: on an idempotent
   * provider the batch goes back to `pending` under its key, to be re-sent as-is next
   * tick; on any other it stays `dispatched`, the ambiguous case that waits for Resolve
   * (§12).
   */
  const deliver = async (key: string, members: DeliveryWork[]): Promise<boolean> => {
    const outcomes: DeliveryOutcome[] = [];
    const byAddress = new Map<string, string>();
    const recipients = [];
    for (const m of members) {
      if (m.unsub_token) {
        byAddress.set(m.email, m.id);
        recipients.push({
          email: m.email,
          unsubscribeUrl: `${config.appOrigin}/unsubscribe?token=${m.unsub_token}`,
        });
      } else {
        // Its subscriber record is gone, so there is no unsubscribe link to address the
        // message with; never send without one (I2).
        outcomes.push({ id: m.id, status: "unsent", error: "no subscriber record" });
      }
    }

    let results: PerRecipientResult[] = [];
    if (recipients.length > 0) {
      budget.spend(); // the provider request, which counts whether or not it answers
      try {
        results = await provider.sendBatch(rendered, recipients, {
          idempotencyKeyPrefix: sendId,
          idempotencyKey: key,
        });
      } catch (err) {
        if (provider.idempotentRetry) {
          await sends.returnUnanswered(db, sendId, lease, key, errorText(err), Date.now());
          result.requeued += members.length;
        }
        return false;
      }
    }

    for (const r of results) {
      const id = byAddress.get(r.email);
      if (!id) {
        continue;
      }
      if (r.accepted) {
        outcomes.push({ id, status: "accepted", providerId: r.providerId });
        result.accepted += 1;
      } else if (r.retryable) {
        outcomes.push({
          id,
          status: "pending",
          error: r.error,
          keepKey: provider.idempotentRetry,
        });
        result.requeued += 1;
      } else {
        outcomes.push({ id, status: "unsent", error: r.error });
        result.unsent += 1;
      }
    }
    await sends.settleDeliveries(db, sendId, lease, "dispatched", outcomes, Date.now());
    return true;
  };

  const release = async (): Promise<SendLoopResult> => {
    await sends.releaseLease(db, sendId, lease);
    return result;
  };

  // First, any batch a previous run handed off without recording the answer: re-send it
  // whole, under its own key, before anything new. Its recipients were handed off
  // already, so consent is not re-checked for them (I2 covers recipients not yet handed
  // off), and re-sending a batch with someone removed would not be the same batch to the
  // provider. Only an idempotent provider dedupes a re-send; on any other (say the
  // provider was switched mid-send) the batch goes back in flight, the ambiguous case
  // that waits for Resolve (§12), rather than sitting in the queue where nothing sends
  // or resolves it.
  for (const key of await sends.unansweredDispatchKeys(db, sendId)) {
    if (!canStartBatch()) {
      break;
    }
    if (!(await keepLease())) {
      return result;
    }
    const moved = new Set(await sends.redispatch(db, sendId, lease, key, Date.now()));
    if (moved.size === 0) {
      if (!(await stillLeased())) {
        return result;
      }
      continue;
    }
    if (!provider.idempotentRetry) {
      continue;
    }
    const members = (await sends.fetchDispatchGroup(db, sendId, key))
      .filter((m) => moved.has(m.id))
      .sort(byEmail);
    if (members.length === 0) {
      continue;
    }
    // The batch retries as a unit, so the cap does too: once any member has used its
    // attempts, the whole batch stops retrying.
    if (members.some((m) => m.attempts >= MAX_DELIVERY_ATTEMPTS)) {
      await sends.settleDeliveries(
        db,
        sendId,
        lease,
        "dispatched",
        members.map((m) => ({ id: m.id, status: "unsent", error: "max attempts exceeded" })),
        Date.now(),
      );
      result.unsent += members.length;
      continue;
    }
    if (!(await deliver(key, members))) {
      return release();
    }
  }

  // Then fresh rows, as many batches as the budget leaves room for.
  const batchSize = Math.min(provider.maxBatch, MAX_CHUNK);
  const affordable = Math.floor((budget.left - CLOSE_COST - 1) / CHUNK_COST);
  const pendingIds =
    affordable > 0 ? await sends.pendingDeliveryIds(db, sendId, affordable * batchSize) : [];

  for (const ids of chunk(pendingIds, batchSize)) {
    if (!canStartBatch()) {
      break;
    }
    if (!(await keepLease())) {
      return result;
    }
    const work = await sends.fetchDeliveryWork(db, ids);

    // Honor unsubscribe/suppression at the last moment (I2), and cap retries.
    const closed: DeliveryOutcome[] = [];
    const live: DeliveryWork[] = [];
    for (const d of work) {
      if (d.sub_status !== "confirmed" || d.suppressed || !d.unsub_token) {
        closed.push({ id: d.id, status: "skipped" });
        result.skipped += 1;
      } else if (d.attempts >= MAX_DELIVERY_ATTEMPTS) {
        closed.push({ id: d.id, status: "unsent", error: "max attempts exceeded" });
        result.unsent += 1;
      } else {
        live.push(d);
      }
    }
    await sends.settleDeliveries(db, sendId, lease, "pending", closed, Date.now());
    if (live.length === 0) {
      continue;
    }

    // Record intent before the network call, under a key this batch keeps until its
    // answer is recorded.
    const key = `${sendId}-${crypto.randomUUID()}`;
    const moved = new Set(
      await sends.dispatchFresh(
        db,
        sendId,
        lease,
        key,
        live.map((l) => l.id),
        Date.now(),
      ),
    );
    if (moved.size === 0) {
      if (!(await stillLeased())) {
        return result;
      }
      continue;
    }
    const members = live.filter((l) => moved.has(l.id)).sort(byEmail);
    if (!(await deliver(key, members))) {
      return release();
    }
  }

  // Complete, or leave it for the next tick to resume.
  if ((await sends.openDeliveryCount(db, sendId)) === 0) {
    await sends.completeSend(db, sendId, send.post_id, Date.now(), lease);
    result.finished = true;
  } else {
    await sends.releaseLease(db, sendId, lease);
  }
  // Dev-only: settle any now-due synthetic receipts from this run's fresh acceptances,
  // so the delivery bar starts filling without waiting for the next sweep. No-op unless
  // the simulation is active.
  await drainSimulatedWebhooks(env, config);
  return result;
}
