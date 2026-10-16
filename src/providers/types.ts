/** The two-method provider seam. Everything provider-specific lives behind it. */

import type { HaltCause, HaltReason } from "../../shared/sends";
import type { AppEnv } from "../env";
import type { RenderedEmail } from "../render/render";

export type { HaltCause, HaltReason, RenderedEmail };

/**
 * How long an adapter waits for the provider to answer a send request before ending it.
 * An ended request is one with no answer, the case the send loop already handles (left in
 * flight for Resolve), so a
 * provider that hangs costs one timeout rather than holding the run past its lease until
 * the Worker is stopped. Generous next to a healthy answer (well under a second), and a
 * small share of the lease.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

export interface Recipient {
  email: string;
  /** Per-recipient unsubscribe URL that replaces the sentinel at send time. */
  unsubscribeUrl: string;
}

/**
 * One recipient's answer. `held` marks a recipient the provider set aside for a reason
 * about itself or the account (a throttle, a spent quota) while it took others in the same
 * request: it goes back to the queue with no attempt spent, as a halted batch does, since
 * the failure is not the recipient's (SPEC §12). `unknown` marks a one-off message's
 * recipient whose request got no answer after earlier ones in the same call were answered,
 * so it may have arrived; a list batch never carries it, since the adapter throws instead.
 */
export type PerRecipientResult =
  | { email: string; accepted: true; providerId: string }
  | {
      email: string;
      accepted: false;
      retryable: boolean;
      error: string;
      held?: true;
      unknown?: true;
    };

/**
 * A batch refused as a whole, for a reason about the provider or the account, never
 * about the recipients in it: nothing in it was accepted. `unavailable`: it cannot take
 * mail right now (an outage, a 5xx, a rate limit), so the same batch is simply tried
 * again later. `account`: it refuses this account (a bad or revoked key, an unverified
 * sending domain, a paused or suspended account), so no retry helps until the operator
 * fixes it. A halt asserts that nothing in the batch was accepted, so the batch is made
 * again from scratch; an answer that leaves the batch's fate unknown is never a halt, and
 * the adapter throws it instead.
 */
export interface BatchHalt {
  reason: HaltReason;
  cause: HaltCause;
  /** The provider's own words, for the operator. Never carries a credential. */
  error: string;
}

/**
 * A provider's answer to one batch: per-recipient results, or a halt that speaks for the
 * whole batch. Only the adapter can tell the two apart, since only it knows what the
 * provider's error means, so the classification stays behind the seam.
 */
export type SendBatchResult =
  | {
      kind: "answered";
      results: PerRecipientResult[];
      /** Why the provider held back the recipients marked `held`, which the send records
       *  as its halt, so the operator hears the cause and the retry waits its backoff. */
      halt?: BatchHalt;
    }
  | { kind: "halted"; halt: BatchHalt };

export type DeliveryEvent =
  | { type: "delivered"; providerId?: string; email?: string }
  | { type: "bounced"; providerId?: string; email?: string; hard: boolean; detail?: string }
  | { type: "complained"; providerId?: string; email?: string; detail?: string };

export interface WebhookResult {
  /** Normalized events to apply to deliveries/suppressions (may be empty). */
  events: DeliveryEvent[];
  /** The exact response to return to the provider (handshakes, 200 ack, ...). */
  response: Response;
}

/**
 * What a batch is for: a `list` send's batch from the send loop, or one of the one-off
 * messages (a post or template `test`, a subscriber's `confirmation`, a `notification` to
 * the publisher). A real transport sends them all alike; the dev simulation models only
 * list sends and hands the rest to the fake outbox, so it is said here, not inferred from
 * the keys.
 */
export type SendPurpose = "list" | "test" | "confirmation" | "notification";

export interface SendBatchOptions {
  /** What the batch is for (see `SendPurpose`). */
  purpose: SendPurpose;
  /** Names the caller: a send id, or a test, confirmation, or notification tag. */
  tag: string;
  /** This batch's own key, when the caller holds one: the send loop's dispatch key, never
   *  reused for another batch. No provider dedupes on it; the fake and the simulation
   *  name what they record by it. */
  batchKey?: string;
}

/**
 * How a provider behaves under the send loop, as its adapter declares it: how many
 * recipients one request takes, and how fast it takes requests. The dev simulation's
 * provider profiles read these from the real adapters, so the two can't drift. No provider
 * dedupes a re-sent request, so the send loop never re-sends one that got no answer.
 */
export interface ProviderTraits {
  /** Max recipients per provider call (the send loop chunks to this). One call makes at
   *  most one outbound request, which is how the send loop budgets it. */
  readonly maxBatch: number;
  /** The most requests a second the provider takes from this account, when it holds the
   *  sender to a rate the send loop should keep under (SES's one bulk request a second). */
  readonly maxRequestRate?: number;
}

export interface EmailProvider extends ProviderTraits {
  readonly name: "none" | "fake" | "ses";

  /** Throws only when the request got no answer at all, whose fate is then unknown. */
  sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult>;

  parseWebhook(req: Request, env: AppEnv): Promise<WebhookResult>;
}
