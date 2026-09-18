/**
 * Dev-only seeded send simulation, behind the two-method provider seam (SPEC §9).
 *
 * The plain `fake` transport accepts every batch instantly with no delivery events, so
 * a live dev send finishes in one sweep tick with nothing to watch. This simulation
 * makes a send unfold over real time and produce a believable, reproducible outcome
 * mix — exercising the REAL send loop, lease, resume, and webhook/suppression path, not
 * a UI mock. It is kept entirely separate from `fake` so the test suite stays instant
 * and deterministic; it engages only when `config.simulateSends` is set in a dev-shaped
 * env (see `getProvider` / `getConfig`), and never in a deployed env (real provider).
 *
 * Two halves, both seeded from the PRNG (#149) keyed per (send, recipient) so a run is
 * reproducible:
 *   1. `SimProvider.sendBatch` paces acceptance with per-batch latency (watchable
 *      dispatch), injects transient errors (→ retry/backoff, phase `retrying`), a RARE
 *      permanent transport failure (→ `unsent`; most bad addresses are accepted here and
 *      bounce asynchronously below, as they do in reality), and — on a large send — a
 *      wall-clock budget that pauses the run between sweep ticks (phase `backing-off`),
 *      exercising resume.
 *   2. `drainSimulatedWebhooks` fabricates DELAYED delivered / bounced / complained
 *      events for accepted recipients and feeds them through the REAL webhook ingest
 *      (`applyDeliveryEvents`). Bounces come in both flavors of the taxonomy every real
 *      provider shares — a PERMANENT (hard) bounce or a complaint suppresses on its own
 *      (I1), a TRANSIENT (soft) bounce is counted but never suppresses (SPEC §9). Receipt
 *      lag is modeled per outcome so the counters settle in the realistic order —
 *      delivered first, bounces next, complaints (feedback loops) last.
 *
 * Provider-agnostic on purpose: this models a generic idempotent, batched provider, so it
 * deliberately does NOT reproduce SES's no-idempotency / ambiguous-transport-error →
 * wedged-send → Resolve path (SPEC §11) — that stays covered by the real SES adapter and
 * the resolve tests — nor reputation-threshold account state.
 */

import { type AcceptedAwaitingEvent, acceptedAwaitingEvent } from "../db/sends";
import type { AppEnv, Config } from "../env";
import { hashString, makePrng } from "../lib/prng";
import { substituteRecipient } from "../render/render";
import { applyDeliveryEvents } from "../services/webhook_events";
import type {
  DeliveryEvent,
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  WebhookResult,
} from "./types";

// --- tuning (dev-only; chosen for a watchable demo, not production fidelity) --------
const MAX_BATCH = 8; // small, so the counters step visibly as a send progresses
const LATENCY_MS = 900; // per-batch pacing latency — makes dispatch take real seconds
// Only pause a *large* send between ticks; a normal-size send (hundreds) must dispatch in
// one continuous window so its bar fills smoothly instead of freezing mid-dispatch waiting
// for the next sweep. At ~18s per ~150 recipients this clears a few thousand per window.
const PACE_BUDGET_MS = 90_000;
const NEW_RUN_GAP_MS = 5_000; // a gap between batches larger than this marks a new sweep tick
const P_TRANSIENT = 0.04; // recipients that hit one transient error, then succeed on retry
// Permanent submit-time rejection is RARE in reality (virus/policy); a syntactically-valid
// but nonexistent address is accepted at submit and bounces asynchronously (see the bounce
// rates below). So submit failures are dominated by the transient throttling above, and a
// hard hand-off failure is a rounding error.
const P_HARD_FAIL = 0.001; // recipients whose hand-off fails at the transport level (no suppress)
const DRAIN_LIMIT = 400; // synthetic events fabricated per drain, to bound a burst

// --- outcome mix for accepted recipients (dev-only; ordered, compressed, provider-agnostic) ---
// These flat, realistic rates apply to EVERY send, at every size. A NORMAL simulated send
// lands ~2.3% bounce / ~0.1% complaint — comfortably under any plausible deliverability alarm,
// so a routine watch never trips a false "bounce spike." Small-list visibility is handled
// separately and explicitly by the guaranteed floor below, so the rates never need juicing to
// stay demonstrative (which would also drag the demo's bounce rate toward that alarm).
//
// Bounces split into the taxonomy every real provider shares (SES `bounceType`, Resend
// `data.bounce.type`): a PERMANENT (hard) bounce suppresses the address (I1); a TRANSIENT
// (soft) bounce is tolerated and counted but never suppresses (SPEC §9). The ingest already
// branches on `hard` — emitting soft bounces is what exercises the counted-not-suppressed path.
const HARD_BOUNCE_RATE = 0.015; // permanent (nonexistent mailbox / blocked) → suppression (I1)
const SOFT_BOUNCE_RATE = 0.008; // transient (mailbox full / temporarily unavailable) → counted only
// Complaints are rare on a healthy list. SES's reputation guidance keeps this < 0.1% and PAUSES
// an account at 0.5% — so the realistic rate is 0.1%, not the old 0.5% that sat right on the
// suspension line.
const COMPLAINT_RATE = 0.001;

// Guaranteed edge-state floor for a small demo send. At the realistic rates above a ~150-address
// demo rounds to ~zero complaints and often zero soft bounces, so a live watch of a small send
// frequently shows none of the edge states the record is meant to demonstrate. Rather than
// distort the rates (see above), we GUARANTEE the states on a small send: any edge state the
// natural roll produced none of is forced onto one otherwise-delivered recipient. It fills only
// genuine gaps — a send that already rolled a soft bounce forces none — so it adds at most one
// event per missing state and leaves the mix essentially realistic. Applies only where the whole
// roster fits a single drain; larger sends produce every state naturally and are left untouched.
const FLOOR_MAX_RECIPIENTS = DRAIN_LIMIT;
const FLOOR_STATES = ["complaint", "soft_bounce", "hard_bounce"] as const;

type SimOutcome = "delivered" | "hard_bounce" | "soft_bounce" | "complaint";

// Receipt lag by outcome — the ABSOLUTE timescale is compressed to seconds for a watchable
// demo, but the RELATIVE ordering holds as real feedback does: a delivery lands in seconds,
// a bounce in seconds-to-a-minute, a complaint hours-to-days later (feedback loops). The
// windows don't overlap, so during a live send the counters settle in the real sequence —
// delivered first, bounces next, complaints last.
const LAG_WINDOWS: Record<SimOutcome, { min: number; spread: number }> = {
  delivered: { min: 3_000, spread: 9_000 }, // ~3–12s
  hard_bounce: { min: 12_000, spread: 18_000 }, // ~12–30s
  soft_bounce: { min: 12_000, spread: 18_000 }, // ~12–30s
  complaint: { min: 45_000, spread: 45_000 }, // ~45–90s (stands in for hours–days)
};

// Apply order within a single drain: delivered, then bounces, then complaints — so even
// when many receipts fall due in one tick (e.g. a long-past send), the ingest still sees
// them in the realistic sequence.
const APPLY_ORDER: Record<SimOutcome, number> = {
  delivered: 0,
  hard_bounce: 1,
  soft_bounce: 1,
  complaint: 2,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Classify an accepted recipient's eventual fate from one [0,1) draw, against a cumulative
 *  ladder ordered rarest-first: complaint, then hard bounce, then soft bounce, else delivered. */
function classifyOutcome(draw: number, complaintRate: number): SimOutcome {
  if (draw < complaintRate) {
    return "complaint";
  }
  if (draw < complaintRate + HARD_BOUNCE_RATE) {
    return "hard_bounce";
  }
  if (draw < complaintRate + HARD_BOUNCE_RATE + SOFT_BOUNCE_RATE) {
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
 *  deterministic and independent of batch order — a run reproduces exactly. */
function recipientRand(sendId: string, email: string): () => number {
  return makePrng(hashString(`${sendId}:${email}`));
}

// Module-level simulation state. Ephemeral (per dev isolate) and keyed by send, so it
// self-limits; losing it on a reload only re-paces from scratch, never double-mails
// (the durable `deliveries` ledger is the guarantee, I4).
const transientSeen = new Set<string>(); // `${sendId}:${email}` that already spent its one transient
// Per-send pacing window. `windowStart` bounds a single run's wall-clock; `lastCallAt`
// detects a new sweep tick (a gap between batches) so the window resets per invocation
// rather than carrying a stale start across ticks (which would pause a resume at once).
const paceState = new Map<string, { windowStart: number; lastCallAt: number }>();
// Per-send forced-outcome overrides for the guaranteed floor (below), computed once from a
// small send's full roster the first time it is drained. Ephemeral like the state above: on an
// isolate reload it recomputes from the still-unsettled rows, which at worst forces one extra
// edge event on a dev demo — never a real mail (the durable `deliveries` ledger is the guard, I4).
const floorOverrides = new Map<string, Map<string, SimOutcome>>();

/** The natural (unforced) outcome for a recipient — the seeded roll at the realistic rates.
 *  This is draw #1 of the recipient's stream; the drain takes draw #2 for the lag, so the two
 *  stay uncorrelated and reproduce the pre-floor sequence exactly. */
function naturalOutcome(sendId: string, email: string): SimOutcome {
  return classifyOutcome(recipientRand(sendId, email)(), COMPLAINT_RATE);
}

/**
 * Compute the guaranteed edge-state floor for every small send in this drain not seen before.
 * Roll each recipient naturally, and for any edge state the send produced none of, force it
 * onto a distinct otherwise-delivered recipient — chosen deterministically so the choice (and
 * so the whole run) reproduces. Records only the overrides; a send that needs no floor records
 * an empty map, which still marks it computed so the roll isn't repeated.
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

export class SimProvider implements EmailProvider {
  // The simulation is a fake-family transport (nothing reaches a real inbox), so it
  // reports as `fake` — the "no email provider configured" labeling (DESIGN §2) and the
  // dev-shaped predicate both stay correct.
  readonly name = "fake" as const;
  readonly maxBatch = MAX_BATCH;
  readonly idempotentRetry = true;

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<PerRecipientResult[]> {
    const sendId = opts.idempotencyKeyPrefix;

    // Wall-clock budget, scoped to one invocation: a gap since the last batch means a new
    // sweep tick, so start a fresh window; otherwise, once this run has spent
    // PACE_BUDGET_MS handing off, throw so the loop requeues this chunk and releases the
    // lease — the send resumes on the next tick (phase `backing-off`), exercising resume.
    const now = Date.now();
    const st = paceState.get(sendId);
    if (st == null || now - st.lastCallAt > NEW_RUN_GAP_MS) {
      paceState.set(sendId, { windowStart: now, lastCallAt: now });
    } else if (now - st.windowStart > PACE_BUDGET_MS) {
      paceState.delete(sendId);
      // The sole dev breadcrumb: an injected pause is the simulator's own decision, not
      // something you'd read off a real send. How a send is *going* is observed through
      // the API (GET /sends/:id/progress) — never through these logs.
      console.log("[sim] injected rate-limit pause; requeueing until the next tick", { sendId });
      throw new Error("simulated rate limit — pausing until the next tick");
    } else {
      st.lastCallAt = now;
    }

    // Pace: a real batch takes time. This is what makes the dispatch bar fill live.
    await sleep(LATENCY_MS);

    return recipients.map((r): PerRecipientResult => {
      const key = `${sendId}:${r.email}`;
      const rand = recipientRand(sendId, r.email);
      const transientDraw = rand();
      const failDraw = rand();

      // One transient error per flagged recipient: retryable the first time, then it
      // succeeds on the next tick — a real retry/backoff, not a permanent failure.
      if (transientDraw < P_TRANSIENT && !transientSeen.has(key)) {
        transientSeen.add(key);
        return {
          email: r.email,
          accepted: false,
          retryable: true,
          error: "simulated transient error (429); will retry",
        };
      }
      // A rare permanent hand-off failure (virus/policy — NOT a bad address, which is
      // accepted here and bounces asynchronously). Does NOT suppress; only the webhook
      // bounce/complaint below does.
      if (failDraw < P_HARD_FAIL) {
        return {
          email: r.email,
          accepted: false,
          retryable: false,
          error: "simulated permanent transport failure (550)",
        };
      }
      // Accepted. Substitute per-recipient values as a real provider would; the
      // deterministic providerId is what the delayed webhook matches on.
      substituteRecipient(rendered, {
        "email.unsubscribeUrl": r.unsubscribeUrl,
        "email.sentTo": r.email,
      });
      return { email: r.email, accepted: true, providerId: `sim-${key}` };
    });
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    // The simulation's events are fabricated internally (see drainSimulatedWebhooks),
    // not received over HTTP, so there is nothing to parse here.
    return { events: [], response: new Response("ok") };
  }
}

/** True when the dev send simulation should engage — dev-shaped env with the opt-in set. */
export function simulationActive(config: Config): boolean {
  return config.provider === "fake" && config.simulateSends;
}

/**
 * Fabricate any now-due delayed delivery webhooks for accepted-but-unconfirmed
 * recipients and apply them through the REAL ingest, so delivery lags acceptance and
 * hard bounces / complaints suppress on their own (I1) while soft bounces are counted
 * without suppressing (SPEC §9). Deterministic per (send, recipient): the outcome and its
 * lag are drawn from the same seeded PRNG, so a given recipient always resolves the same
 * way and a re-drain never double-applies (an event clears `event IS NULL`). Because the
 * lag is longest for complaints and shortest for deliveries, receipts come due — and are
 * applied — in the realistic order. A small send additionally gets the guaranteed edge-state
 * floor (see `ensureFloor`) so its watch always shows every state. No-op unless the simulation
 * is active. Returns events applied.
 */
export async function drainSimulatedWebhooks(env: AppEnv, config: Config): Promise<number> {
  if (!simulationActive(config)) {
    return 0;
  }
  const now = Date.now();
  const rows = await acceptedAwaitingEvent(env.DB, DRAIN_LIMIT);
  // Fix each small send's guaranteed floor before classifying, so a forced complaint takes the
  // complaint lag (longest) and still settles last, in order.
  ensureFloor(rows);
  const due: { outcome: SimOutcome; event: DeliveryEvent }[] = [];
  for (const row of rows) {
    const rand = recipientRand(row.send_id, row.email);
    // Draw #1 is the natural roll; a guaranteed-floor override may replace the outcome. Draw #2
    // (the lag) is taken off the same stream regardless, so lag stays uncorrelated with outcome
    // and the sequence reproduces exactly. The forced outcome's own window still sets the lag —
    // a forced complaint lags longest and settles last, in order.
    const natural = classifyOutcome(rand(), COMPLAINT_RATE);
    const lagDraw = rand();
    const outcome = floorOverrides.get(row.send_id)?.get(row.email) ?? natural;
    const lag = lagFor(outcome, lagDraw);
    if (row.updated_at + lag > now) {
      continue; // not due yet — its receipt still lags (longest for complaints)
    }
    due.push({ outcome, event: outcomeEvent(outcome, row.email, row.provider_id ?? undefined) });
  }
  if (due.length === 0) {
    return 0;
  }
  // Feed the ingest in realistic order: delivered first, bounces next, complaints last.
  due.sort((a, b) => APPLY_ORDER[a.outcome] - APPLY_ORDER[b.outcome]);
  const { applied } = await applyDeliveryEvents(
    env.DB,
    due.map((d) => d.event),
  );
  return applied;
}
