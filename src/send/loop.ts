/**
 * The resumable, at-most-once send loop (I1, I2, I4). Only the sweep calls it.
 *
 * `deliveries` is both the work queue and the at-most-once ledger. A recipient is
 * only ever selected while `pending`; we flip it to `dispatched` BEFORE the
 * network call, under a dispatch key saved on the row, and to `accepted`/`unsent`
 * after, so a crash can never re-mail an accepted recipient. A batch whose answer
 * was never recorded is never re-sent: no provider dedupes a re-send, so its
 * recipients stay in flight until the publisher's Resolve (SPEC §12). Each invocation
 * attempts each recipient at most once; retryables go back to `pending` as fresh rows
 * and wait for the next sweep tick (the backoff).
 *
 * A failure that is the provider's or the account's rather than a recipient's (the
 * adapter's halt) halts the run, not the recipients: the batch goes back to `pending` as
 * fresh rows with no attempt spent, the send records the halt and stays open, and the
 * sweep tries again once the halt's backoff (`HALT_BACKOFF_MS`) has passed, however long
 * the halt lasts; an answer that holds no one back ends it (SPEC §12). A halt is the
 * account's or the provider's, not one send's, so while one send waits one out, another that
 * starts or resumes joins it without a request (`accountHalt`). A request with no answer halts the
 * run the same way, but its batch stays in flight for Resolve.
 * Only a recipient's own retryable failure counts toward `MAX_DELIVERY_ATTEMPTS`.
 *
 * A run spends against the invocation's subrequest budget (`budget.ts`) and stops
 * starting batches while it can still close cleanly; the next tick continues. A provider
 * that takes one recipient a request has its requests grouped (`GROUP_RECIPIENTS`) so
 * they share the D1 writes. Requests keep the provider's rate (`maxRequestRate`), and a
 * run stops starting them near the end of the tick (`pace.ts`).
 *
 * The run logs its send's lifecycle (SPEC §12): `send.fired` when it takes a scheduled send,
 * one `send.batch` a group (counts, never addresses), `send.halted` and `send.resumed`
 * around a provider's halt, `send.ambiguous` when a batch's fate becomes unknown,
 * `send.lease_lost`, and `send.completed`. Each line is written after the step it describes
 * and reads only what the run already holds, so logging costs no query and no decision.
 */

import { haltRank } from "../../shared/sends";
import type { DeliveryOutcome, DeliveryWork } from "../db/sends";
import * as sends from "../db/sends";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { errorText, log } from "../lib/log";
import {
  HALT_BACKOFF_MS,
  HALT_RETRY_SLACK_MS,
  LEASE_TTL_MS,
  MAX_DELIVERY_ATTEMPTS,
} from "../lib/time";
import { getProvider } from "../providers";
import { drainSimulatedWebhooks } from "../providers/simulate";
import type { BatchHalt, HaltReason } from "../providers/types";
import { Budget, metered } from "./budget";
import { SendWindow } from "./pace";

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
 * The fewest recipients one hand-off write covers. A provider that takes fewer recipients a
 * request than this (SES on an account allowed fewer than this many a second) would
 * otherwise pay a whole batch's D1 writes for every few recipients, so its requests go in
 * groups this size that share the writes: about half a D1 statement a recipient instead
 * of five at one recipient a request. It is also the most recipients a run cut off mid-group can
 * leave waiting for Resolve on such a provider (SPEC §12). A provider that batches this many or more sends one batch a group.
 */
const GROUP_RECIPIENTS = 10;
// What a run can cost, in D1 statements (and, where noted, provider requests), so it
// only starts what it can finish. Each is an upper bound; the budget counts what is
// actually spent.
/** Opening: read the send, take the lease, look for another send's halt, resolve the
 *  audience (2), list the fresh rows. */
const OPEN_COST = 6;
/** One group, besides a request for each of its batches: read its rows, close any no
 *  longer to be mailed (2), renew the lease, hand off (2), record the outcomes (2). A
 *  group with a halted batch also records the hold (3), but then the run only releases
 *  the lease, which leaves that much of the close unspent. */
const GROUP_COST = 8;
/** What a group usually costs, besides its requests: the read, the hand-off, and the
 *  record. Sizes the read of fresh rows, which may read more than a run gets to. */
const GROUP_TYPICAL_COST = 5;
/** Closing: count what is left, then complete the send (3) or release the lease. */
const CLOSE_COST = 4;
/** The least a run needs to be worth starting: its opening, one group of one request,
 *  and its close. */
export const MIN_RUN_COST = OPEN_COST + GROUP_COST + 1 + CLOSE_COST;

/** The halt a group records (`haltRank`): an account refusal outranks one send's own, which
 *  outranks a provider that is only unavailable, since the publisher has to act on it and
 *  the account's other sends wait on it. */
function worseHalt(current: BatchHalt | null, next: BatchHalt): BatchHalt {
  return !current || haltRank(next) > haltRank(current) ? next : current;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** A batch's recipients in one fixed order, so a batch reads the same in the record and the log. */
function byEmail(a: DeliveryWork, b: DeliveryWork): number {
  return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
}

export async function runSend(
  env: AppEnv,
  sendId: string,
  budget: Budget = new Budget(getConfig(env).subrequestBudget),
  window?: SendWindow,
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
  const tags = { sendId, postId: send.post_id, provider: provider.name };
  if (send.status === "scheduled") {
    log.info("send.fired", { ...tags, lagMs: now - send.fire_at });
  }
  // The halt the send carried into this run, for the `send.halted` and `send.resumed`
  // lines: the first answered batch clears it.
  let halted = send.halt_reason
    ? { reason: send.halt_reason, retries: send.halt_retries, at: send.halted_at }
    : null;
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

  // While another send waits out a refusal or an outage, this one would only meet the same
  // answer, or strand a batch for Resolve on a provider that has gone silent: it joins that
  // halt and retries with it, asking the provider nothing (SPEC §12). Before the audience,
  // so a send held from the start fixes it when it first hands off, not while held.
  const standing = await sends.accountHalt(db, sendId, Date.now() + HALT_RETRY_SLACK_MS);
  if (standing) {
    await sends.joinHalt(db, sendId, lease, standing);
    log.warn("send.halted", {
      ...tags,
      reason: standing.reason,
      cause: standing.cause,
      error: standing.error,
      retryAt: new Date(standing.retryAt).toISOString(),
      heldBy: standing.sendId,
    });
    await sends.releaseLease(db, sendId, lease);
    return { ...empty, leased: true, halt: standing.reason };
  }

  // The first run fixes the audience (SPEC §6); every later run works the rows that
  // exist, so a reader who confirms mid-send gets the next post, not this one. The guard
  // in `resolveAudience` makes a racing first run a no-op.
  if (send.audience_resolved_at === null) {
    await sends.resolveAudience(db, sendId, now);
  }

  const result: SendLoopResult = { ...empty, leased: true };
  /** Stop because another run took the lease: it owns the send now. */
  const leaseLost = (): SendLoopResult => {
    log.warn("send.lease_lost", tags);
    return result;
  };
  const rendered = { subject: send.subject, html: send.rendered_html, text: send.rendered_text };

  /** One batch of a group: its rows, and the key it goes out under. */
  interface Batch {
    key: string;
    members: DeliveryWork[];
  }

  // The tick's clock when the sweep runs this, so every send it runs keeps one pace and
  // one deadline; a run of its own gets its own.
  const clock = window ?? new SendWindow(provider.maxRequestRate);

  /**
   * Send a group of handed-off batches, each under its own key, and record every answer
   * in one write. False when any batch got no per-recipient answer, which ends the run.
   *
   * A halted batch provably reached no one, so it goes back to the queue as fresh rows,
   * no attempt spent, which re-checks each recipient's consent when it is handed off
   * again (I2), and the send records the halt. A request with no answer at all stays
   * `dispatched`: its fate is unknown, and no provider dedupes a re-send, so it waits for
   * Resolve (§12).
   *
   * The group's requests go out together, each started no sooner than the provider's
   * rate allows, so a group costs about one request's wait rather than one per batch.
   */
  const deliver = async (batches: Batch[]): Promise<boolean> => {
    const outcomes: DeliveryOutcome[] = [];
    const held: string[] = [];
    let halt: BatchHalt | null = null;
    let requeued = 0;
    let progressed = false;
    let complete = true;
    // For the `send.batch` line: every member of the group lands in exactly one of its
    // counts (accepted, unsent, retried, held, unknown), so they sum to `recipients`.
    let latencyMs = 0;
    let heldCount = 0;
    let unknown = 0;

    const calls = batches.map((b) => {
      const byAddress = new Map<string, number>();
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
          // message with; never send without one (I2). The hand-off already closes such a
          // row as skipped, so this only guards a future caller that doesn't.
          outcomes.push({ id: m.id, status: "unsent", error: "no subscriber record" });
          result.unsent += 1;
        }
      }
      return { batch: b, byAddress, recipients };
    });

    const sent = calls.filter((c) => c.recipients.length > 0);
    const send = async (call: (typeof sent)[number]) => {
      await clock.pace();
      budget.request(); // the request counts whether or not it answers
      const started = Date.now();
      try {
        const answer = await provider.sendBatch(rendered, call.recipients, {
          purpose: "list",
          tag: sendId,
          batchKey: call.batch.key,
        });
        return { call, answer, lost: undefined };
      } catch (err) {
        return { call, answer: null, lost: errorText(err) };
      } finally {
        latencyMs = Math.max(latencyMs, Date.now() - started);
      }
    };
    // The first request goes alone: a refused account or a provider that is down refuses
    // the whole group, and each retry of a long halt would otherwise pay for every one.
    // The rest go together once it is answered.
    const [first, ...rest] = sent;
    const answers = first ? [await send(first)] : [];
    const probe = answers[0]?.answer;
    if (probe?.kind === "answered" && !probe.halt) {
      answers.push(...(await Promise.all(rest.map(send))));
    } else {
      // Handed off but never sent: back to the queue, no key kept (none of them reached the
      // provider on this attempt), since the first request found the provider refusing,
      // down, or not answering.
      for (const call of rest) {
        held.push(call.batch.key);
        requeued += call.batch.members.length;
        heldCount += call.recipients.length;
      }
    }

    for (const { call, answer, lost } of answers) {
      const { batch, byAddress } = call;
      let batchHalt: BatchHalt | null = null;
      if (answer === null) {
        complete = false;
        unknown += call.recipients.length; // stays in flight, awaiting Resolve (§12)
        // The provider may be down or unreachable: the send waits out the outage's backoff
        // rather than strand a fresh batch every tick. Only the halt is taken; this batch
        // stays in flight.
        halt = worseHalt(halt, {
          reason: "unavailable",
          cause: "outage",
          error: lost ?? "no answer",
        });
      } else if (answer.kind === "halted") {
        complete = false;
        batchHalt = answer.halt;
      } else {
        // An answer that took or settled someone is progress; one that only held recipients
        // back is not. Only progress with no one held back ends a halt (below).
        if (answer.results.some((r) => r.accepted || r.held !== true)) {
          progressed = true;
        }
        // Recipients the provider held back for its own reasons go back with no attempt
        // spent, and the send records why, as for a halted batch. Only the halt is taken:
        // the batch's other rows were answered, or are in flight with their fate unknown.
        if (answer.halt) {
          halt = worseHalt(halt, answer.halt);
          complete = false; // the provider is refusing for now, so the run stops here
        }
        let answeredFor = 0;
        for (const r of answer.results) {
          const id = byAddress.get(r.email);
          if (!id) {
            continue;
          }
          answeredFor += 1;
          if (r.accepted) {
            outcomes.push({ id, status: "accepted", providerId: r.providerId });
            result.accepted += 1;
          } else if (r.retryable) {
            outcomes.push({
              id,
              status: "pending",
              error: r.error,
              ...(r.held ? { attempt: false as const } : {}),
            });
            result.requeued += 1;
          } else {
            outcomes.push({ id, status: "unsent", error: r.error });
            result.unsent += 1;
          }
        }
        // A recipient the answer left out stays in flight, its fate unknown.
        unknown += Math.max(0, call.recipients.length - answeredFor);
      }
      if (batchHalt) {
        held.push(batch.key);
        requeued += batch.members.length;
        heldCount += call.recipients.length;
        halt = worseHalt(halt, batchHalt);
      }
    }

    // The provider working again ends the halt the send carried. An account refusal is the
    // exception: an answer that took some and refused the rest for the account (a quota
    // freeing up a few at a time) continues it, keeping when it began and its backoff, so
    // the publisher is told once (SPEC §12). Anything else held back, such as SES throttling
    // a few entries for the account's rate, is pace rather than a fault a person fixes: the
    // progress ends the halt and the hold starts afresh, a minute out.
    const cleared = progressed && halt?.reason !== "account";
    await sends.settleDeliveries(db, sendId, lease, "dispatched", outcomes, Date.now(), {
      progressed,
      clears: cleared,
    });
    // One reading of the clock for the hold and its log line, so the `retryAt` logged is
    // the retry time stored.
    const heldAt = Date.now();
    await sends.holdBatch(
      db,
      sendId,
      lease,
      held,
      halt,
      HALT_BACKOFF_MS[halt?.reason ?? "unavailable"],
      heldAt,
    );
    result.requeued += requeued;
    if (halt) {
      result.halt = halt.reason;
    }

    const count = (status: DeliveryOutcome["status"]) =>
      outcomes.filter((o) => o.status === status).length;
    // Recipients the provider held back for its own reasons count as held, not retried.
    const heldBack = outcomes.filter((o) => o.status === "pending" && o.attempt === false).length;
    log.info("send.batch", {
      ...tags,
      requests: answers.length,
      recipients: batches.reduce((n, b) => n + b.members.length, 0),
      accepted: count("accepted"),
      unsent: count("unsent"),
      retried: count("pending") - heldBack,
      held: heldCount + heldBack,
      unknown,
      latencyMs,
    });
    if (cleared && halted) {
      log.info("send.resumed", {
        ...tags,
        reason: halted.reason,
        haltedMs: halted.at === null ? undefined : Date.now() - halted.at,
      });
      halted = null;
    }
    if (halt) {
      // The step `holdBatch` just took from the reason's schedule.
      const backoff = HALT_BACKOFF_MS[halt.reason];
      const prior = halted?.reason === halt.reason ? halted.retries : 0;
      const delay = backoff[Math.min(prior, backoff.length - 1)] ?? 0;
      log.warn("send.halted", {
        ...tags,
        reason: halt.reason,
        cause: halt.cause,
        error: halt.error,
        retryAt: new Date(heldAt + delay).toISOString(),
      });
    }
    if (unknown > 0) {
      log.error("send.ambiguous", { ...tags, recipients: unknown, cause: "no_answer" });
    }
    return complete;
  };

  /** Hand the send back to the sweep. A batch still in flight stays there: nothing re-sends
   *  it, so it waits for Resolve (`WEDGED_SEND`). */
  const release = async (): Promise<SendLoopResult> => {
    await sends.releaseLease(db, sendId, lease);
    return result;
  };

  // Fresh rows, a group at a time, as many groups as the budget and the run's window
  // leave room for. A batch a previous run handed off without recording its answer is
  // left in flight exactly as it is, the ambiguous case that waits for Resolve (§12), so
  // it costs this run nothing. The read is sized by what a group usually costs, so the run spends its
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
   *  or the tick's time is short, so a tight budget still sends; zero once the run should
   *  stop. */
  const nextGroupCalls = (): number => {
    const byQueries = budget.queriesLeft >= GROUP_COST + CLOSE_COST ? groupCalls : 0;
    return Math.max(
      0,
      Math.min(byQueries, budget.left - GROUP_COST - CLOSE_COST, clock.startsLeft()),
    );
  };

  for (let at = 0; at < pendingIds.length; ) {
    const room = nextGroupCalls();
    if (room < 1) {
      break;
    }
    if (!(await keepLease())) {
      return leaseLost();
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
        return leaseLost();
      }
      continue;
    }
    const batches = handOffs
      .map((h) => ({
        key: h.key,
        members: live.filter((l) => moved.get(l.id) === h.key).sort(byEmail),
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
    log.info("send.completed", { ...tags, durationMs: Date.now() - (send.started_at ?? now) });
  } else {
    await sends.releaseLease(db, sendId, lease);
  }
  // Dev-only: settle any now-due synthetic receipts from this run's fresh acceptances,
  // so the delivery bar starts filling without waiting for the next sweep. No-op unless
  // the simulation is active.
  await drainSimulatedWebhooks(env, config);
  return result;
}
