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
 * A failure that is the provider's or the account's rather than a recipient's (the
 * adapter's halt, or a request with no answer) halts the run, not the recipients: the
 * batch goes back to `pending` with no attempt spent, the send records the halt and stays
 * open, and the sweep tries the same batch again once the halt's backoff (`HALT_BACKOFF_MS`)
 * has passed, however long the halt lasts; an answered batch ends it (SPEC §12).
 * Only a recipient's own retryable failure counts toward `MAX_DELIVERY_ATTEMPTS`.
 *
 * A run spends against the invocation's subrequest budget (`budget.ts`) and stops
 * starting batches while it can still close cleanly; the next tick continues. A provider
 * that takes one recipient a request has its requests grouped (`GROUP_RECIPIENTS`) so
 * they share the D1 writes, and paced to the provider's rate (`maxRequestRate`).
 */

import type { DeliveryOutcome, DeliveryWork } from "../db/sends";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { HALT_BACKOFF_MS, LEASE_TTL_MS, MAX_DELIVERY_ATTEMPTS } from "../lib/time";
import { getProvider } from "../providers";
import { drainSimulatedWebhooks } from "../providers/simulate";
import type { BatchHalt, HaltReason } from "../providers/types";
import { Budget, metered } from "./budget";

export interface SendLoopResult {
  sendId: string;
  leased: boolean;
  accepted: number;
  skipped: number;
  unsent: number;
  requeued: number;
  finished: boolean;
  /** Why the run stopped at a halted batch, or null if it did not. */
  halt: HaltReason | null;
}

/** The most recipients in one batch, whatever the provider allows. */
const MAX_CHUNK = 500;

/**
 * The fewest recipients one hand-off write covers. A provider that takes one recipient a
 * request (SES) would otherwise pay a whole batch's D1 writes for each recipient, so its
 * requests go in groups this size that share the writes: about half a D1 statement a
 * recipient instead of five. It is also the most recipients a run cut off mid-group can
 * leave waiting for Resolve on such a provider, which has no idempotency key to re-send
 * under (SPEC §12). A provider that batches this many or more sends one batch a group.
 */
const GROUP_RECIPIENTS = 10;
/** How long a run keeps starting groups, so a send paced to its provider's rate hands the
 *  rest to the next tick rather than running into it. */
const RUN_WINDOW_MS = 50 * 1000;

// What a run can cost, in D1 statements (and, where noted, provider requests), so it
// only starts what it can finish. Each is an upper bound; the budget counts what is
// actually spent.
/** Opening: read the send, take the lease, resolve the audience (2), list the
 *  unanswered batches and the fresh rows. */
const OPEN_COST = 6;
/** One group, besides a request for each of its batches: read its rows, close any no
 *  longer to be mailed (2), renew the lease, hand off (2), record the outcomes (2). A
 *  group with a halted batch also records the hold (3), but then the run only releases
 *  the lease, which leaves that much of the close unspent. */
const GROUP_COST = 8;
/** What a group usually costs, besides its requests: the read, the hand-off, and the
 *  record. Sizes the read of fresh rows, which may read more than a run gets to. */
const GROUP_TYPICAL_COST = 5;
/** Re-sending one unanswered batch, besides its request: renew the lease, hand it off
 *  again (2), read its rows, record the outcomes (2). */
const REDO_COST = 6;
/** Closing: count what is left, then complete the send (3) or release the lease. */
const CLOSE_COST = 4;
/** The least a run needs to be worth starting: its opening, one group of one request,
 *  and its close. */
export const MIN_RUN_COST = OPEN_COST + GROUP_COST + 1 + CLOSE_COST;

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

/**
 * Spaces request starts to at most `rate` a second: each call resolves when the next
 * request may start. Starts are reserved in call order, so requests started together
 * still go out one gap apart. No rate means no wait.
 */
function pacer(rate: number | undefined): () => Promise<void> {
  if (!rate) {
    return async () => {};
  }
  const gap = 1000 / rate;
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) {
      await new Promise((resolve) => setTimeout(resolve, at - now));
    }
  };
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
    halt: null,
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

  // The first run fixes the audience (SPEC §6); every later run works the rows that
  // exist, so a reader who confirms mid-send gets the next post, not this one. The guard
  // in `resolveAudience` makes a racing first run a no-op.
  if (send.audience_resolved_at === null) {
    await sends.resolveAudience(db, sendId, now);
  }

  const result: SendLoopResult = { ...empty, leased: true };
  const rendered = { subject: send.subject, html: send.rendered_html, text: send.rendered_text };

  /** One batch of a group: its rows, the key it goes out under, and whether this is its
   *  first request under that key. */
  interface Batch {
    key: string;
    members: DeliveryWork[];
    firstAttempt: boolean;
  }

  const pace = pacer(provider.maxRequestRate);

  /**
   * Send a group of handed-off batches, each under its own key, and record every answer
   * in one write. False when any batch got no per-recipient answer, which ends the run.
   *
   * A halted batch goes back to the queue, no attempt spent, and the send records the
   * halt. It keeps its key only while its fate is unknown: this attempt may have been
   * accepted, or an earlier one may have (a batch is only ever re-sent under its key
   * because an earlier attempt left its fate unknown). A batch refused on its first
   * attempt provably reached no one, so it goes back as fresh rows, which re-checks each
   * recipient's consent when it is handed off again (I2) and leaves nothing under a key
   * for another provider to mistake for an ambiguous delivery. A request with no answer
   * at all goes back the same way on an idempotent provider, under its key, to be re-sent
   * as-is next tick; on any other it stays `dispatched`, the ambiguous case that waits for
   * Resolve (§12).
   *
   * The group's requests go out together, each started no sooner than the provider's
   * rate allows, so a group costs about one request's wait rather than one per batch.
   */
  const deliver = async (batches: Batch[]): Promise<boolean> => {
    const outcomes: DeliveryOutcome[] = [];
    const held: sends.HeldBatch[] = [];
    let halt: BatchHalt | null = null;
    let requeued = 0;
    let answered = false;
    let complete = true;

    const calls = batches.map((b) => {
      const byAddress = new Map<string, string>();
      const recipients = [];
      for (const m of b.members) {
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
          result.unsent += 1;
        }
      }
      return { batch: b, byAddress, recipients };
    });

    const sent = calls.filter((c) => c.recipients.length > 0);
    const send = async (call: (typeof sent)[number]) => {
      await pace();
      budget.request(); // the request counts whether or not it answers
      try {
        const answer = await provider.sendBatch(rendered, call.recipients, {
          idempotencyKeyPrefix: sendId,
          idempotencyKey: call.batch.key,
        });
        return { call, answer, lost: undefined };
      } catch (err) {
        return { call, answer: null, lost: errorText(err) };
      }
    };
    // The first request goes alone: a refused account or a provider that is down refuses
    // the whole group, and each retry of a long halt would otherwise pay for every one.
    // The rest go together once it is answered.
    const [first, ...rest] = sent;
    const answers = first ? [await send(first)] : [];
    const probe = answers[0]?.answer;
    if (probe?.kind === "answered") {
      answers.push(...(await Promise.all(rest.map(send))));
    } else {
      // Handed off but never sent: back to the queue with the halted one, no key kept
      // (none of them reached the provider on this attempt).
      for (const call of rest) {
        held.push({
          key: call.batch.key,
          keepKey: provider.idempotentRetry && !call.batch.firstAttempt,
        });
        requeued += call.batch.members.length;
      }
    }

    for (const { call, answer, lost } of answers) {
      const { batch, byAddress } = call;
      let batchHalt: BatchHalt | null = null;
      if (answer === null) {
        complete = false;
        if (provider.idempotentRetry) {
          batchHalt = {
            reason: "unavailable",
            cause: "outage",
            error: lost ?? "no answer",
            mayHaveSent: true,
          };
        }
      } else if (answer.kind === "halted") {
        complete = false;
        batchHalt = answer.halt;
      } else {
        answered = true;
        for (const r of answer.results) {
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
      }
      if (batchHalt) {
        held.push({
          key: batch.key,
          keepKey: provider.idempotentRetry && (batchHalt.mayHaveSent || !batch.firstAttempt),
        });
        requeued += batch.members.length;
        // An account refusal outranks a provider that is only unavailable: it is the one
        // the publisher has to act on.
        if (!halt || (halt.reason === "unavailable" && batchHalt.reason === "account")) {
          halt = batchHalt;
        }
      }
    }

    await sends.settleDeliveries(db, sendId, lease, "dispatched", outcomes, Date.now(), answered);
    await sends.holdBatch(
      db,
      sendId,
      lease,
      held,
      halt,
      HALT_BACKOFF_MS[halt?.reason ?? "unavailable"],
      Date.now(),
    );
    result.requeued += requeued;
    if (halt) {
      result.halt = halt.reason;
      if (halt.reason === "account") {
        console.error("PROVIDER_REFUSED", { sendId, provider: provider.name, error: halt.error });
      }
    }
    return complete;
  };

  const release = async (): Promise<SendLoopResult> => {
    await sends.releaseLease(db, sendId, lease);
    return result;
  };

  // First, any batch a previous run handed off without recording the answer: re-send it
  // whole, under its own key, before anything new. Its recipients were handed off
  // already, so consent is not re-checked for them (I2 covers recipients not yet handed
  // off), and re-sending a batch with someone removed would not be the same batch to the
  // provider. Only an idempotent provider dedupes a re-send, and only while it still
  // remembers the key. On any other (say the provider was switched mid-send), or once
  // the key is older than the provider's memory of it, a batch waiting in the queue
  // under its key goes back in flight, the ambiguous case that waits for Resolve (§12),
  // rather than sitting where nothing sends or resolves it. Batches already in flight
  // there are left exactly as they are, so they neither eat this run's budget nor look
  // freshly touched to the sweep's stale-delivery flag.
  const keyWindow = provider.idempotencyWindowMs;
  const keyedBefore = keyWindow === undefined ? null : Date.now() - keyWindow;
  const unanswered = await sends.unansweredDispatchKeys(
    db,
    sendId,
    !provider.idempotentRetry,
    keyedBefore,
  );
  for (const { key, keyedAt } of unanswered) {
    if (!budget.affords(REDO_COST + CLOSE_COST, 1)) {
      break;
    }
    if (!(await keepLease())) {
      return result;
    }
    const forgotten = keyedBefore !== null && keyedAt !== null && keyedAt < keyedBefore;
    const toResolve = !provider.idempotentRetry || forgotten;
    const moved = new Set(await sends.redispatch(db, sendId, lease, key, Date.now(), toResolve));
    if (moved.size === 0) {
      if (!(await stillLeased())) {
        return result;
      }
      continue;
    }
    if (toResolve) {
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
    if (!(await deliver([{ key, members, firstAttempt: false }]))) {
      return release();
    }
  }

  // Then fresh rows, a group at a time, as many groups as the budget and the run's window
  // leave room for. The read is sized by what a group usually costs, so the run spends its
  // whole budget; rows it doesn't reach stay `pending` for the next tick.
  const batchSize = Math.min(provider.maxBatch, MAX_CHUNK);
  const groupCalls = Math.max(1, Math.floor(GROUP_RECIPIENTS / batchSize));
  const groups = Math.min(
    Math.floor((budget.queriesLeft - CLOSE_COST - 1) / GROUP_TYPICAL_COST),
    Math.floor((budget.left - CLOSE_COST - 1) / (GROUP_TYPICAL_COST + groupCalls)),
  );
  const pendingIds =
    groups > 0 ? await sends.pendingDeliveryIds(db, sendId, groups * groupCalls * batchSize) : [];
  /** How many requests the next group may make: its full size, or fewer when the budget
   *  is short, so a tight budget still sends; zero once the run should stop. */
  const nextGroupCalls = (): number => {
    if (Date.now() - now >= RUN_WINDOW_MS) {
      return 0;
    }
    const byQueries = budget.queriesLeft >= GROUP_COST + CLOSE_COST ? groupCalls : 0;
    return Math.max(0, Math.min(byQueries, budget.left - GROUP_COST - CLOSE_COST));
  };

  for (let at = 0; at < pendingIds.length; ) {
    const room = nextGroupCalls();
    if (room < 1) {
      break;
    }
    if (!(await keepLease())) {
      return result;
    }
    const ids = pendingIds.slice(at, at + room * batchSize);
    at += ids.length;
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

    // Record intent before any request leaves, each batch under a key it keeps until its
    // answer is recorded.
    const handOffs = chunk(live, batchSize).map((members) => ({
      key: `${sendId}-${crypto.randomUUID()}`,
      ids: members.map((m) => m.id),
    }));
    const moved = new Map(
      (await sends.dispatchFresh(db, sendId, lease, handOffs, Date.now())).map((r) => [
        r.id,
        r.key,
      ]),
    );
    if (moved.size === 0) {
      if (!(await stillLeased())) {
        return result;
      }
      continue;
    }
    const batches = handOffs
      .map((h) => ({
        key: h.key,
        members: live.filter((l) => moved.get(l.id) === h.key).sort(byEmail),
        firstAttempt: true,
      }))
      .filter((b) => b.members.length > 0);
    if (!(await deliver(batches))) {
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
