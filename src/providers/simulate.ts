/**
 * The local send simulation, behind the two-method provider seam (SPEC §10).
 *
 * The plain `fake` accepts every batch instantly and never reports a receipt, so a local
 * send finishes in one sweep tick with nothing to watch and none of the ways a real
 * provider fails. This stands in for a real provider on LIST sends only, so a local run
 * models what a deployed one does, through the REAL send loop, lease, resume, halt, and
 * webhook ingest, not a UI mock. A test send, a confirmation, or a notification goes to the
 * fake outbox untouched and unfaulted: those are the publisher's own checks and a reader's
 * sign-up, and a simulated refusal of either would only get in the way. Simulated list
 * sends land in the same outbox, so the delivered bytes can be inspected. It engages only
 * when `config.simulation` is set, which `getConfig` allows only in a dev-shaped env.
 *
 * One simulator, a profile per provider (`SIMULATE_SENDS`):
 *   - `resend` and `ses` take their traits from the real adapters (`RESEND_TRAITS`,
 *     `sesTraits`: batch size, idempotency, how long a key is remembered, and SES's send
 *     rate, which the send loop paces to), and answer a failure the way the adapter answers
 *     it: the halt comes from the adapter's own classifier and wording. Each request takes
 *     a request's time: Resend's carries a batch, SES's one recipient.
 *   - `generic` is a small-batch idempotent provider paced to be watched: slow batches and
 *     a transient refusal for a few recipients.
 *
 * Two fault levels. `realistic` injects what a real provider does: a rare permanent refusal,
 * a rare request that leaves with no answer (its fate unknown, §12), receipts with bounces
 * and complaints at real rates, and, so a demo shows them, each of the profile's edge states
 * at least once per send. For SES those are the two that need the publisher: a request lost
 * in flight, which on a provider with no idempotency key leaves the send wedged until Resolve,
 * and the account's daily sending quota running out, an account-level halt whose retries are
 * spaced out as a real one's are. `none` runs clean: every recipient accepted and delivered.
 *
 * Receipts are normalized delivery events applied through `applyDeliveryEvents`, the same
 * path a verified webhook takes; the provider's webhook HTTP and signatures are the
 * adapters' own tests' business. A recipient's rolls are seeded per (send, recipient) and
 * the guaranteed edge states' places per send, so they hold however the loop batches and
 * retries; a request's rare loss is rolled on its batch key, which is new at every
 * hand-off, so it falls differently from run to run.
 *
 * Where it is faster than production, it says so: receipts that take hours (a complaint)
 * arrive within minutes, and a spent quota lifts before the send's first retry instead of
 * after a day.
 */

import type { SimulationFaults, SimulationProfile, SimulationView } from "../../shared/settings";
import { type AcceptedAwaitingEvent, acceptedAwaitingEvent } from "../db/sends";
import type { AppEnv, Config } from "../env";
import { hashString, makePrng } from "../lib/prng";
import { HALT_BACKOFF_MS, HALT_RETRY_SLACK_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";
import { applyDeliveryEvents } from "../services/webhook_events";
import { deliverToOutbox, FakeProvider } from "./fake";
import { RESEND_TRAITS } from "./resend";
import { classifySesError, sesErrorText, sesTraits } from "./ses";
import type {
  BatchHalt,
  DeliveryEvent,
  EmailProvider,
  PerRecipientResult,
  ProviderTraits,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "./types";

// --- provider profiles --------------------------------------------------------------

/** How one simulated provider behaves: its traits, its pace, and its failures. */
interface SimProfile {
  /** The provider's traits, as its adapter declares them for this deployment's config. */
  traits: (config: Config) => ProviderTraits;
  /** How long one request to the provider takes. */
  requestMs: number;
  /** Recipients refused once with a retryable error, accepted on the retry. */
  transientRate: number;
  /** Requests that leave and get no answer: the provider may have sent them (§12). */
  lostRate: number;
  /** Recipients the provider refuses for good at hand-off (rare: a bad address is
   *  accepted and bounces later). */
  rejectRate: number;
  rejectError: string;
  /** The account's sending quota running out, as the adapter reports it; null for a
   *  profile that doesn't model it. */
  quota: BatchHalt | null;
  /** Which edge states `realistic` guarantees once per send, so a demo shows them. The lost
   *  request is placed after the quota lifts, so it comes only with the quota. */
  guaranteed: { lost: boolean; quota: boolean };
}

/** An adapter's classification of an error response, with its wording: the halt the real
 *  adapter would return for that response. */
function adapterHalt(classified: Omit<BatchHalt, "error"> | null, error: string): BatchHalt {
  return { ...unwrap(classified, "a halting error response"), error };
}

const SES_QUOTA = {
  status: 429,
  type: "TooManyRequestsException",
  msg: "Daily message quota exceeded.",
};

/**
 * Each profile is built when a simulation asks for it, never at module load: the send loop
 * and sweep import this module in every environment, so a profile that can't be built (an
 * adapter answer `adapterHalt` can't read) fails the dev server simulating that provider,
 * never a deployed Worker's startup.
 */
const PROFILES: Record<SimulationProfile, () => SimProfile> = {
  generic: () => ({
    traits: () => ({ maxBatch: 8, idempotentRetry: true }),
    requestMs: 900,
    transientRate: 0.04,
    lostRate: 0,
    rejectRate: 0.001,
    rejectError: "simulated permanent transport failure (550)",
    quota: null,
    guaranteed: { lost: false, quota: false },
  }),
  resend: () => ({
    traits: () => RESEND_TRAITS,
    requestMs: 500,
    transientRate: 0,
    lostRate: 0.0005,
    rejectRate: 0.001,
    rejectError: "The `to` field is invalid. (simulated)",
    quota: null,
    guaranteed: { lost: false, quota: false },
  }),
  ses: () => ({
    // The send loop keeps requests to the account's send rate (`maxRequestRate`); this is
    // how long each one takes to be answered.
    traits: sesTraits,
    requestMs: 80,
    transientRate: 0,
    lostRate: 0.0005,
    rejectRate: 0.001,
    rejectError: sesErrorText(
      400,
      "MessageRejected",
      "Email address is on the account's suppression list. (simulated)",
    ),
    quota: adapterHalt(
      classifySesError(SES_QUOTA.status, SES_QUOTA.type, SES_QUOTA.msg),
      sesErrorText(SES_QUOTA.status, SES_QUOTA.type, SES_QUOTA.msg),
    ),
    guaranteed: { lost: true, quota: true },
  }),
};

// --- receipts: outcome mix and lag ----------------------------------------------------

const DRAIN_LIMIT = 400; // synthetic events fabricated per drain, to bound a burst

// These flat, realistic rates apply to EVERY send, at every size. A NORMAL simulated send
// lands ~2.3% bounce / ~0.1% complaint, comfortably under any plausible deliverability alarm,
// so a routine watch never trips a false "bounce spike." Small-list visibility is handled
// separately by the guaranteed floor below, so the rates never need juicing to stay
// demonstrative.
//
// Bounces split into the taxonomy every real provider shares (SES `bounceType`, Resend
// `data.bounce.type`): a PERMANENT (hard) bounce suppresses the address (I1); a TRANSIENT
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** Per-recipient PRNG, keyed by (send, email), so every decision about a recipient is
 *  deterministic and independent of batch order: a run reproduces exactly. */
function recipientRand(sendId: string, email: string): () => number {
  return makePrng(hashString(`${sendId}:${email}`));
}

/** One [0,1) draw named by `tag`, for a decision about a request rather than a recipient. */
function drawFor(tag: string): number {
  return makePrng(hashString(tag))();
}

// --- per-send state -----------------------------------------------------------------
// Module-level, keyed by send or batch key, so it lasts as long as the dev isolate, which
// `wrangler dev` keeps from one sweep tick to the next until a reload. Losing it forgets
// which guaranteed edge states a send has had, so one may happen once more; it never
// double-mails, because the durable `deliveries` ledger is the guarantee (I4).

/** One send as the simulated provider has seen it. */
interface SendSim {
  /** Requests made for the send, refused ones included. */
  requests: number;
  /** When the send's quota ran out, or null while it hasn't. */
  quotaSpentAt: number | null;
  /** Requests the provider took since the quota lifted. */
  resumed: number;
  /** Whether a request of the send has been lost in flight. */
  lost: boolean;
}

/** `${sendId}:${email}` that already spent their one transient refusal. */
const transientSeen = new Set<string>();
/** Batch keys whose request was already lost once: a re-send under the key is answered. */
const lostKeys = new Set<string>();
const sendState = new Map<string, SendSim>();
/** Per small send: the forced receipt outcomes of the guaranteed floor. */
const floorOverrides = new Map<string, Map<string, SimOutcome>>();

/** Forget every simulated send's state, as a restarted dev server would. For tests. */
export function resetSimulation(): void {
  transientSeen.clear();
  lostKeys.clear();
  sendState.clear();
  floorOverrides.clear();
}

/**
 * Where a guaranteed edge state falls, counting from 1 and seeded by the send: the quota runs
 * out on the send's 2nd to 4th request, early enough that a small demo reaches it, and the
 * lost request is the 2nd to 5th after the quota lifts, so the send halts, resumes at its
 * retry, and only then loses one. Not the 1st: the loop sends that one alone to try the
 * account, and its answer is what clears the halt.
 */
function guaranteedAt(sendId: string, state: "lost" | "quota"): number {
  return state === "quota"
    ? 2 + (hashString(`${sendId}:quota`) % 3)
    : 2 + (hashString(`${sendId}:lost`) % 4);
}

/**
 * How long a spent quota refuses the send: until the earliest the sweep may run the halt's
 * first retry (its first step, less the slack a due retry is given). That covers every
 * request of the run it halted, those the loop sent alongside the refused one included, and
 * the retry always finds it lifted, since the halt is stamped after the refusal. Kept on
 * `Date`, the clock the retry time is kept on. A real quota lifts over a day. Computed on
 * use, like the profiles, so nothing here can fail at module load.
 */
function quotaHoldMs(): number {
  return unwrap(HALT_BACKOFF_MS.account[0], "the first account backoff step") - HALT_RETRY_SLACK_MS;
}

/**
 * The local send simulation as a provider. List sends run through the profile; everything
 * else goes to the fake outbox as the plain fake would send it.
 */
export class SimProvider implements EmailProvider {
  // A fake-family transport (nothing reaches a real inbox), so it reports as `fake`: the
  // "no email provider configured" labeling (DESIGN §2) and the dev-shaped predicate hold.
  readonly name = "fake" as const;
  readonly maxBatch: number;
  readonly idempotentRetry: boolean;
  readonly idempotencyWindowMs?: number;
  readonly maxRequestRate?: number;

  private readonly profile: SimProfile;
  private readonly faults: SimulationFaults;
  private readonly fake = new FakeProvider();

  constructor(simulation: SimulationView, config: Config) {
    this.profile = PROFILES[simulation.profile]();
    this.faults = simulation.faults;
    const traits = this.profile.traits(config);
    this.maxBatch = traits.maxBatch;
    this.idempotentRetry = traits.idempotentRetry;
    this.idempotencyWindowMs = traits.idempotencyWindowMs;
    this.maxRequestRate = traits.maxRequestRate;
  }

  /** One list batch is one request to the provider (SES's batches are one recipient). */
  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    if (opts.purpose !== "list") {
      return this.fake.sendBatch(rendered, recipients, opts);
    }
    const sendId = opts.idempotencyKeyPrefix;
    const key = opts.idempotencyKey ?? sendId;
    const realistic = this.faults === "realistic";
    const p = this.profile;
    const state = sendState.get(sendId) ?? {
      requests: 0,
      quotaSpentAt: null,
      resumed: 0,
      lost: false,
    };
    sendState.set(sendId, state);
    state.requests += 1;

    // A spent quota answers before anything is sent, so the provider took no one. It
    // refuses every request until it lifts, not only the one that spent it: the loop sends
    // a group's requests together, so the rest are already on their way.
    if (realistic && p.quota && p.guaranteed.quota) {
      const now = Date.now();
      if (state.quotaSpentAt === null && state.requests >= guaranteedAt(sendId, "quota")) {
        state.quotaSpentAt = now;
        console.log("[sim] sending quota spent; the send halts until its next retry", {
          sendId,
        });
      }
      if (state.quotaSpentAt !== null && now < state.quotaSpentAt + quotaHoldMs()) {
        return { kind: "halted", halt: p.quota };
      }
    }
    // This request's place since the quota lifted, taken as it arrives: by the time it is
    // answered, the requests the loop sent alongside it have counted too.
    const resumed = state.quotaSpentAt === null ? 0 : ++state.resumed;
    await sleep(p.requestMs);
    const results = this.answer(sendId, rendered, recipients, opts);
    // A request lost in flight: the provider took it (it is in the outbox), but its answer
    // never came, so its fate is unknown to the send (§12).
    if (realistic && this.lost(sendId, key, state, resumed)) {
      console.log("[sim] request lost in flight; its fate is unknown to the send", {
        sendId,
        key,
      });
      throw new Error(
        "simulated network error: the connection closed before the provider answered",
      );
    }
    return { kind: "answered", results };
  }

  /** Whether this request is lost in flight: once per send when the profile guarantees it,
   *  at its place after the quota lifts (`resumed`), otherwise at the profile's rate; never
   *  twice under one key, so a re-send is answered. */
  private lost(sendId: string, key: string, state: SendSim, resumed: number): boolean {
    if (lostKeys.has(key)) {
      return false;
    }
    const guaranteed =
      this.profile.guaranteed.lost && !state.lost && resumed >= guaranteedAt(sendId, "lost");
    if (guaranteed || drawFor(`${key}:lost`) < this.profile.lostRate) {
      state.lost = true;
      lostKeys.add(key);
      return true;
    }
    return false;
  }

  /** Each recipient's answer to one request, delivering the accepted ones to the outbox. */
  private answer(
    sendId: string,
    rendered: RenderedEmail,
    group: Recipient[],
    opts: SendBatchOptions,
  ): PerRecipientResult[] {
    const realistic = this.faults === "realistic";
    return group.map((r): PerRecipientResult => {
      const rand = recipientRand(sendId, r.email);
      const transientDraw = rand();
      const rejectDraw = rand();
      const seen = `${sendId}:${r.email}`;
      if (realistic && transientDraw < this.profile.transientRate && !transientSeen.has(seen)) {
        transientSeen.add(seen);
        return {
          email: r.email,
          accepted: false,
          retryable: true,
          error: "simulated transient error (429); will retry",
        };
      }
      if (realistic && rejectDraw < this.profile.rejectRate) {
        return {
          email: r.email,
          accepted: false,
          retryable: false,
          error: this.profile.rejectError,
        };
      }
      return unwrap(deliverToOutbox(rendered, [r], opts)[0], "outbox delivery");
    });
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    // The simulation's receipts are fabricated internally (see drainSimulatedWebhooks),
    // not received over HTTP, so there is nothing to parse here.
    return { events: [], response: new Response("ok") };
  }
}

/** True when the local send simulation is on: a dev-shaped env with `SIMULATE_SENDS` set. */
export function simulationActive(config: Config): boolean {
  return config.provider === "fake" && config.simulation !== null;
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
