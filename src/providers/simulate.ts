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
 *      dispatch), injects transient errors (→ retry/backoff, phase `retrying`), a small
 *      fraction of hard transport failures (→ `failed`), and — on a large send — a
 *      wall-clock budget that pauses the run between sweep ticks (phase `backing-off`),
 *      exercising resume.
 *   2. `drainSimulatedWebhooks` fabricates DELAYED delivered / bounced / complained
 *      events for accepted recipients and feeds them through the REAL webhook ingest
 *      (`applyDeliveryEvents`), so the accepted→delivered lag is real and hard bounces /
 *      complaints suppress on their own (I1) — the two-phase "done" made visible.
 */

import { acceptedAwaitingEvent } from "../db/sends";
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
const P_HARD_FAIL = 0.01; // recipients whose hand-off fails at the transport level (no suppress)
const DELIVERY_MIN_MS = 3_000; // earliest a delivery receipt lags acceptance
const DELIVERY_SPREAD_MS = 27_000; // added spread, so receipts trickle in over ~30s
const BOUNCE_RATE = 0.02; // accepted recipients that later hard-bounce (→ suppression, I1)
const COMPLAINT_RATE = 0.005; // accepted recipients that later complain (→ suppression, I1)
const DRAIN_LIMIT = 400; // synthetic events fabricated per drain, to bound a burst

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      // A small fraction fail hard at the transport level (does NOT suppress — only the
      // webhook bounce/complaint below does).
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
 * hard bounces / complaints suppress on their own (I1). Deterministic per (send,
 * recipient): the lag and the outcome are drawn from the same seeded PRNG, so a given
 * recipient always resolves the same way and a re-drain never double-applies (an event
 * clears `event IS NULL`). No-op unless the simulation is active. Returns events applied.
 */
export async function drainSimulatedWebhooks(env: AppEnv, config: Config): Promise<number> {
  if (!simulationActive(config)) {
    return 0;
  }
  const now = Date.now();
  const rows = await acceptedAwaitingEvent(env.DB, DRAIN_LIMIT);
  const events: DeliveryEvent[] = [];
  for (const row of rows) {
    const rand = recipientRand(row.send_id, row.email);
    const lag = DELIVERY_MIN_MS + rand() * DELIVERY_SPREAD_MS;
    if (row.updated_at + lag > now) {
      continue; // not due yet — its receipt still lags
    }
    const outcomeDraw = rand();
    const providerId = row.provider_id ?? undefined;
    if (outcomeDraw < COMPLAINT_RATE) {
      events.push({
        type: "complained",
        providerId,
        email: row.email,
        detail: "simulated complaint",
      });
    } else if (outcomeDraw < COMPLAINT_RATE + BOUNCE_RATE) {
      events.push({
        type: "bounced",
        providerId,
        email: row.email,
        hard: true,
        detail: "simulated hard bounce (550)",
      });
    } else {
      events.push({ type: "delivered", providerId, email: row.email });
    }
  }
  if (events.length === 0) {
    return 0;
  }
  const { applied } = await applyDeliveryEvents(env.DB, events);
  return applied;
}
