/**
 * The local send simulation's receipts (SPEC §10): the reports SES would send back for what the
 * simulated provider took, fabricated and applied through `applyDeliveryEvents`, the same path
 * a verified webhook takes, and the app's wait for a report settled as the simulated return path
 * would. It reads and writes the database, so it sits outside the provider seam; the provider
 * (`src/providers/simulate/`) only takes or refuses email. The provider's webhook HTTP and
 * signatures are the adapters' own tests' business.
 *
 * Receipts with bounces and complaints arrive at real rates, plus, under `realistic`, each edge
 * state at least once on a small send so a demo shows it. They are seeded per (send, recipient),
 * so a run reproduces. Where it is faster than production, it says so: receipts that take hours
 * (a complaint) arrive within minutes, and the warning that reports aren't arriving shows two
 * minutes after an email instead of an hour (`SIMULATED_RECEIPT_WAIT`).
 *
 * An email outside a list send (a test, a confirmation, a notification) has no delivery row,
 * so its report is settled on its own (`settleWait`): a few seconds after the app starts
 * waiting for one, as SES's report of it would arrive. `SIMULATE_ACCOUNT`'s `:unreported`
 * withholds every report, a list send's included, and `:wrong_topic` has each arrive from a
 * topic other than `SNS_TOPIC_ARN`, refused as the webhook refuses one, so the warning can be
 * seen locally by the path that raises it (SPEC §13).
 */

import type { SimulatedReceipts } from "../../shared/settings";
import { readSending, receiptStatement, refusedTopicStatement } from "../db/sending";
import { type AcceptedAwaitingEvent, acceptedAwaitingEvent } from "../db/sends";
import type { AppEnv, Config } from "../env";
import { hashString } from "../lib/prng";
import { recipientRand, simulationActive } from "../providers/simulate/provider";
import type { DeliveryEvent } from "../providers/types";
import { applyDeliveryEvents } from "../services/webhook_events";

/**
 * The cron value the local dev ticker (`cli/sweep-ticker.mjs`, which spells the same
 * string) sends every few seconds to have the scheduled handler settle the simulated receipts
 * that have come due, and nothing else: receipts then arrive on their own clock, as a
 * provider's webhooks do, whether or not a page is open (SPEC §10). It is not a cron
 * expression, so no deployed trigger can carry it.
 */
export const RECEIPTS_CRON = "dev:receipts";

const DRAIN_LIMIT = 400; // synthetic events fabricated per drain, to bound a burst

// These flat, realistic rates apply to EVERY send, at every size. A NORMAL simulated send
// lands ~2.3% bounce / ~0.1% complaint, comfortably under any plausible deliverability alarm,
// so a routine watch never trips a false "bounce spike." Small-list visibility is handled
// separately by the guaranteed floor below, so the rates never need juicing to stay
// demonstrative.
//
// Bounces split into the taxonomy real providers share (SES's `bounceType`): a PERMANENT (hard) bounce suppresses the address (I1); a TRANSIENT
// (soft) bounce is tolerated and counted but never suppresses (SPEC §10).
const HARD_BOUNCE_RATE = 0.015; // permanent (nonexistent mailbox / blocked) → suppression (I1)
const SOFT_BOUNCE_RATE = 0.008; // transient (mailbox full / temporarily unavailable) → counted only
// Complaints are rare on a healthy list. SES's reputation guidance keeps this < 0.1% and
// PAUSES an account at 0.5%, so the realistic rate is 0.1%.
const COMPLAINT_RATE = 0.001;

// Guaranteed edge-state floor for a small send. At the realistic rates a ~150-address demo
// rounds to ~zero complaints and often zero soft bounces, so any edge state the natural roll
// produced none of is forced onto one otherwise-delivered recipient. It fills only genuine
// gaps, adding at most one event per missing state. Applies only where the whole roster fits
// a single drain; larger sends produce every state naturally.
const FLOOR_MAX_RECIPIENTS = DRAIN_LIMIT;
const FLOOR_STATES = ["complaint", "soft_bounce", "hard_bounce"] as const;

type SimOutcome = "delivered" | "hard_bounce" | "soft_bounce" | "complaint";

// Receipt lag by outcome. The ABSOLUTE timescale is compressed for a watchable demo (a
// complaint arrives in about a minute, standing in for hours or days), but the RELATIVE
// order holds as real feedback does: delivered first, bounces next, complaints last.
const LAG_WINDOWS: Record<SimOutcome, { min: number; spread: number }> = {
  delivered: { min: 3_000, spread: 9_000 }, // ~3–12s
  hard_bounce: { min: 12_000, spread: 18_000 }, // ~12–30s
  soft_bounce: { min: 12_000, spread: 18_000 }, // ~12–30s
  complaint: { min: 45_000, spread: 45_000 }, // ~45–90s (stands in for hours–days)
};

// Apply order within one drain, so the ingest sees receipts in the realistic sequence even
// when many fall due at once.
const APPLY_ORDER: Record<SimOutcome, number> = {
  delivered: 0,
  hard_bounce: 1,
  soft_bounce: 1,
  complaint: 2,
};

/** Per small send: the forced receipt outcomes of the guaranteed floor. Module-level, so it
 *  lasts as long as the dev isolate, as the provider's per-send state does. */
const floorOverrides = new Map<string, Map<string, SimOutcome>>();

/** Forget every simulated send's receipt floor, as a restarted dev server would. For tests. */
export function resetSimulatedReceipts(): void {
  floorOverrides.clear();
}

/** Classify an accepted recipient's eventual fate from one [0,1) draw, against a cumulative
 *  ladder ordered rarest-first: complaint, then hard bounce, then soft bounce, else delivered. */
function classifyOutcome(draw: number): SimOutcome {
  if (draw < COMPLAINT_RATE) {
    return "complaint";
  }
  if (draw < COMPLAINT_RATE + HARD_BOUNCE_RATE) {
    return "hard_bounce";
  }
  if (draw < COMPLAINT_RATE + HARD_BOUNCE_RATE + SOFT_BOUNCE_RATE) {
    return "soft_bounce";
  }
  return "delivered";
}

/** Receipt lag for an outcome, from one [0,1) draw over that outcome's window. */
function lagFor(outcome: SimOutcome, draw: number): number {
  const w = LAG_WINDOWS[outcome];
  return w.min + draw * w.spread;
}

/** The normalized delivery event an outcome produces, as it would arrive over the seam. */
function outcomeEvent(
  outcome: SimOutcome,
  email: string,
  providerId: string | undefined,
): DeliveryEvent {
  switch (outcome) {
    case "complaint":
      return { type: "complained", providerId, email, detail: "simulated complaint" };
    case "hard_bounce":
      return {
        type: "bounced",
        providerId,
        email,
        hard: true,
        detail: "simulated hard bounce (550, nonexistent mailbox)",
      };
    case "soft_bounce":
      return {
        type: "bounced",
        providerId,
        email,
        hard: false,
        detail: "simulated soft bounce (transient; mailbox full)",
      };
    case "delivered":
      return { type: "delivered", providerId, email };
  }
}

/** The natural (unforced) outcome for a recipient: the seeded roll at the realistic rates.
 *  Draw #1 of the recipient's stream; the drain takes draw #2 for the lag, so the two stay
 *  uncorrelated. */
function naturalOutcome(sendId: string, email: string): SimOutcome {
  return classifyOutcome(recipientRand(sendId, email)());
}

/**
 * Compute the guaranteed edge-state floor for every small send in this drain not seen before.
 * Roll each recipient naturally, and for any edge state the send produced none of, force it
 * onto a distinct otherwise-delivered recipient, chosen deterministically so the run
 * reproduces. A send that needs no floor records an empty map, which still marks it computed.
 */
function ensureFloor(rows: AcceptedAwaitingEvent[]): void {
  const bySend = new Map<string, AcceptedAwaitingEvent[]>();
  for (const row of rows) {
    if (floorOverrides.has(row.send_id) || row.recipient_count > FLOOR_MAX_RECIPIENTS) {
      continue; // already computed, or too large to floor (roster may exceed one drain)
    }
    const list = bySend.get(row.send_id);
    if (list) {
      list.push(row);
    } else {
      bySend.set(row.send_id, [row]);
    }
  }
  for (const [sendId, list] of bySend) {
    const present = new Set<SimOutcome>();
    const delivered: string[] = [];
    for (const row of list) {
      const outcome = naturalOutcome(sendId, row.email);
      present.add(outcome);
      if (outcome === "delivered") {
        delivered.push(row.email);
      }
    }
    // A stable order over the delivered pool, so which recipients get converted reproduces.
    delivered.sort(
      (a, b) => hashString(`floor:${sendId}:${a}`) - hashString(`floor:${sendId}:${b}`),
    );
    const overrides = new Map<string, SimOutcome>();
    let next = 0;
    for (const state of FLOOR_STATES) {
      const victim = delivered[next];
      if (present.has(state) || victim === undefined) {
        continue; // already occurs naturally, or no delivered recipient left to convert
      }
      overrides.set(victim, state);
      next += 1;
    }
    floorOverrides.set(sendId, overrides);
  }
}

/**
 * Fabricate any now-due delivery receipts for accepted-but-unconfirmed recipients and apply
 * them through the REAL ingest, so delivery lags acceptance and hard bounces / complaints
 * suppress on their own (I1) while soft bounces are counted without suppressing (SPEC §10).
 * Deterministic per (send, recipient): the outcome and its lag are drawn from the same seeded
 * PRNG, so a recipient always resolves the same way and a re-drain never double-applies (an
 * event clears `event IS NULL`). Under `realistic` a small send also gets the guaranteed
 * floor (see `ensureFloor`); under `none` every receipt is a delivery. No-op unless the
 * simulation is on. Returns events applied.
 */
export async function drainSimulatedWebhooks(env: AppEnv, config: Config): Promise<number> {
  if (!simulationActive(config)) {
    return 0;
  }
  const realistic = config.simulation?.faults === "realistic";
  const now = Date.now();
  const receipts = config.simulation?.account?.receipts ?? "reported";
  await settleWait(env, config, receipts, now);
  if (receipts !== "reported") {
    return 0; // the return path is broken: no report reaches the app
  }
  const rows = await acceptedAwaitingEvent(env.DB, DRAIN_LIMIT);
  if (realistic) {
    // Fix each small send's floor before classifying, so a forced complaint takes the
    // complaint lag (longest) and still settles last.
    ensureFloor(rows);
  }
  const due: { outcome: SimOutcome; event: DeliveryEvent }[] = [];
  for (const row of rows) {
    const rand = recipientRand(row.send_id, row.email);
    // Draw #1 is the natural roll and draw #2 the lag, taken off the same stream whatever the
    // outcome, so lag stays uncorrelated with it and the sequence reproduces.
    const natural = classifyOutcome(rand());
    const lagDraw = rand();
    const outcome = realistic
      ? (floorOverrides.get(row.send_id)?.get(row.email) ?? natural)
      : "delivered";
    if (row.updated_at + lagFor(outcome, lagDraw) > now) {
      continue; // not due yet: its receipt still lags (longest for complaints)
    }
    due.push({ outcome, event: outcomeEvent(outcome, row.email, row.provider_id ?? undefined) });
  }
  if (due.length === 0) {
    return 0;
  }
  due.sort((a, b) => APPLY_ORDER[a.outcome] - APPLY_ORDER[b.outcome]);
  const { applied } = await applyDeliveryEvents(
    env.DB,
    due.map((d) => d.event),
  );
  return applied;
}

/** How long after the app starts waiting for a report the simulation's report arrives. */
const WAIT_REPORT_LAG_MS = 5_000;

/** How long the simulation waits for a report before it warns: two minutes, not production's
 *  hour, so the warning can be seen without waiting it out. */
export const SIMULATED_RECEIPT_WAIT = { ms: 2 * 60_000, words: "two minutes" } as const;

/**
 * Settle the app's wait for a report as the simulated return path would (SPEC §13): with
 * reports reaching the app, a report arrives a few seconds after the wait starts, so a test or
 * a confirmation, which has no delivery row, clears it too; from the wrong topic, the webhook
 * refuses one, once a wait; unreported, nothing arrives.
 */
async function settleWait(
  env: AppEnv,
  config: Config,
  receipts: SimulatedReceipts,
  now: number,
): Promise<void> {
  const row = await readSending(env.DB);
  const since = row?.waitingSince ?? null;
  if (since === null || now - since < WAIT_REPORT_LAG_MS || receipts === "unreported") {
    return;
  }
  if (receipts === "reported") {
    await receiptStatement(env.DB, now).run();
    return;
  }
  if ((row?.refusedTopic?.at ?? 0) < since) {
    // Another topic in the expected one's account and region, the only kind the webhook keeps.
    const expected =
      env.SNS_TOPIC_ARN?.trim() || `arn:aws:sns:${config.awsRegion}:111122223333:kestrel-events`;
    await refusedTopicStatement(env.DB, { topic: `${expected}-old`, expected }, now).run();
  }
}
