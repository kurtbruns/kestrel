/**
 * The local send simulation as a provider, behind the two-method provider seam (SPEC §10).
 *
 * The plain `fake` accepts every batch instantly and never reports a receipt, so a local
 * send finishes in one sweep tick with nothing to watch and none of the ways a real
 * provider fails. This stands in for a real provider on LIST sends, so a local run
 * models what a deployed one does, through the REAL send loop, lease, resume, halt, and
 * webhook ingest, not a UI mock. A test send, a confirmation, or a notification goes to the
 * fake outbox unfaulted: those are the publisher's own checks and a reader's sign-up, and a
 * random fault in either would only get in the way. The developer's one answer (`answers.ts`)
 * and the sandbox reach every email they would on a real account: a refusal of the account or
 * an outage every email, a refusal of a send's own email only that send's (and, for a rejected
 * message, a test of a post), and the sandbox every recipient it doesn't mail. Simulated list
 * sends land in the same outbox, so the delivered bytes can be inspected. It engages only when
 * `config.simulation` is set, which `getConfig` allows only in a dev-shaped env.
 *
 * Two fault levels. `realistic` injects what the profile's provider does (`profiles.ts`): a
 * rare permanent refusal, a rare request that leaves with no answer (its fate unknown, §12),
 * and, so a demo shows them, each of the profile's edge states at least once per send. For SES
 * those are the two that need the publisher: a request lost in flight, which leaves the send
 * wedged until Resolve, since nothing re-sends it, and the account's daily sending quota
 * running out, an account-level halt whose retries are spaced out as a real one's are. `none`
 * runs clean: every recipient accepted. A recipient's rolls are seeded per (send, recipient)
 * and the guaranteed edge states' places per send, so they hold however the loop batches and
 * retries; a request's rare loss is rolled on its batch key, which is new at every hand-off,
 * so it falls differently from run to run. A spent quota lifts before the send's first retry
 * instead of after a day.
 *
 * The receipts for what it takes are fabricated outside the provider, in
 * `src/dev/simulated_receipts.ts`, since settling them reads and writes the database.
 *
 * Each injected fault is logged as a `sim.*` event tagged with the profile (`sim.quota_spent`,
 * `sim.quota_lifted`, `sim.request_lost`, `sim.send_refused`), so a simulated send's log shows
 * what was injected beside what the app did about it.
 */

import type {
  SimulatedSendRefusal,
  SimulationFaults,
  SimulationProfile,
  SimulationView,
} from "../../../shared/settings";
import type { AppEnv, Config } from "../../env";
import { log } from "../../lib/log";
import { hashString, makePrng } from "../../lib/prng";
import { HALT_BACKOFF_MS, HALT_RETRY_SLACK_MS } from "../../lib/time";
import { unwrap } from "../../lib/unwrap";
import { deliverToOutbox, FakeProvider } from "../fake";
import { bareAddress, sesBulkError } from "../ses";
import type {
  BatchHalt,
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "../types";
import { everyEmailHalt, SEND_REFUSALS, sandboxRefusal, sesHalt } from "./answers";
import { PROFILES, type SimProfile } from "./profiles";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Per-recipient PRNG, keyed by (send, email), so every decision about a recipient is
 *  deterministic and independent of batch order: a run reproduces exactly. The receipts take
 *  their own stream from the same seed. */
export function recipientRand(sendId: string, email: string): () => number {
  return makePrng(hashString(`${sendId}:${email}`));
}

/** One [0,1) draw named by `tag`, for a decision about a request rather than a recipient. */
function drawFor(tag: string): number {
  return makePrng(hashString(tag))();
}

/** True when the local send simulation is on: a dev-shaped env with `SIMULATE_SENDS` set. */
export function simulationActive(config: Config): boolean {
  return config.provider === "fake" && config.simulation !== null;
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
/** Batch keys whose request was already lost once, so one batch is never lost twice. */
const lostKeys = new Set<string>();
const sendState = new Map<string, SendSim>();

/** Forget every simulated send's state, as a restarted dev server would. For tests. */
export function resetSimulatedSends(): void {
  transientSeen.clear();
  lostKeys.clear();
  sendState.clear();
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
  // local stand-in labeling (DESIGN §4) and the dev-shaped predicate hold.
  readonly name = "fake" as const;
  readonly maxBatch: number;
  readonly maxRequestRate?: number;

  private readonly profile: SimProfile;
  private readonly profileName: SimulationProfile;
  private readonly faults: SimulationFaults;
  private readonly fake = new FakeProvider();
  private readonly config: Config;
  /** The halt every email meets (a refusal of the account, or an outage), when the developer named one. */
  private readonly everyEmail: BatchHalt | null;
  /** How SES refuses each send's own email, when the developer named it. */
  private readonly sendRefusal: SimulatedSendRefusal | null;

  constructor(simulation: SimulationView, config: Config) {
    this.profile = PROFILES[simulation.profile]();
    this.profileName = simulation.profile;
    this.faults = simulation.faults;
    this.config = config;
    const answer = simulation.answer;
    this.everyEmail = everyEmailHalt(answer, config);
    this.sendRefusal =
      answer?.kind === "bad_request" || answer?.kind === "rejected" ? answer.kind : null;
    const traits = this.profile.traits(config);
    this.maxBatch = traits.maxBatch;
    this.maxRequestRate = traits.maxRequestRate;
  }

  /** One list batch is one request to the provider. */
  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    // The account's, as a real account's is: a test, a confirmation, and the publisher's own
    // notification about it meet it too.
    if (this.everyEmail) {
      return { kind: "halted", halt: this.everyEmail };
    }
    const own = this.sendRefusal ? SEND_REFUSALS[this.sendRefusal] : null;
    const from = bareAddress(this.config.fromAddress);
    if (own?.tests && opts.purpose === "test") {
      return { kind: "halted", halt: sesHalt(own, from) };
    }
    if (opts.purpose !== "list") {
      return this.oneOff(rendered, recipients, opts);
    }
    const sandboxed = sandboxRefusal(recipients, this.config);
    if (sandboxed) {
      return { kind: "halted", halt: sandboxed };
    }
    const sendId = opts.tag;
    if (this.sendRefusal && own) {
      await sleep(this.profile.requestMs);
      log.info("sim.send_refused", {
        sendId,
        profile: this.profileName,
        answer: this.sendRefusal,
        recipients: recipients.length,
      });
      return sesBulkError(own.status, own.type, own.msg, from, recipients);
    }
    const key = opts.batchKey ?? sendId;
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
        log.info("sim.quota_spent", {
          sendId,
          profile: this.profileName,
          liftsAt: new Date(now + quotaHoldMs()).toISOString(),
        });
      }
      if (state.quotaSpentAt !== null && now < state.quotaSpentAt + quotaHoldMs()) {
        return { kind: "halted", halt: p.quota };
      }
      if (state.quotaSpentAt !== null && state.resumed === 0) {
        log.info("sim.quota_lifted", { sendId, profile: this.profileName });
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
      log.info("sim.request_lost", {
        sendId,
        profile: this.profileName,
        recipients: recipients.length,
      });
      throw new Error(
        "simulated network error: the connection closed before the provider answered",
      );
    }
    return { kind: "answered", results };
  }

  /**
   * A one-off message, one request a recipient as the adapter sends it: through to the fake
   * outbox, unless the sandbox refuses the recipient. A refusal of the first request speaks
   * for the call, as the adapter's does; a later one holds back the rest.
   */
  private async oneOff(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const out: PerRecipientResult[] = [];
    for (const [i, r] of recipients.entries()) {
      const refused = sandboxRefusal([r], this.config);
      if (!refused) {
        const answer = await this.fake.sendBatch(rendered, [r], opts);
        out.push(...(answer.kind === "answered" ? answer.results : []));
        continue;
      }
      if (i === 0) {
        return { kind: "halted", halt: refused };
      }
      for (const rest of recipients.slice(i)) {
        out.push({
          email: rest.email,
          accepted: false,
          retryable: true,
          error: refused.error,
          held: true,
        });
      }
      return { kind: "answered", results: out, halt: refused };
    }
    return { kind: "answered", results: out };
  }

  /** Whether this request is lost in flight: once per send when the profile guarantees it,
   *  at its place after the quota lifts (`resumed`), otherwise at the profile's rate; never
   *  twice under one key. */
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
    // The simulation's receipts are fabricated outside the provider
    // (src/dev/simulated_receipts.ts), not received over HTTP, so there is nothing to parse.
    return { events: [], response: new Response("ok") };
  }
}
