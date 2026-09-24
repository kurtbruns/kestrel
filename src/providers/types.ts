/** The two-method provider seam. Everything provider-specific lives behind it. */

import type { HaltCause, HaltReason } from "../../shared/sends";
import type { AppEnv } from "../env";
import type { RenderedEmail } from "../render/render";

export type { HaltCause, HaltReason, RenderedEmail };

/**
 * How long an adapter waits for the provider to answer a send request before ending it.
 * An ended request is one with no answer, the case the send loop already handles (re-sent
 * under its key where the provider dedupes, otherwise left in flight for Resolve), so a
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

export type PerRecipientResult =
  | { email: string; accepted: true; providerId: string }
  | { email: string; accepted: false; retryable: boolean; error: string };

/**
 * A batch refused as a whole, for a reason about the provider or the account, never
 * about the recipients in it: nothing in it was accepted. `unavailable`: it cannot take
 * mail right now (an outage, a 5xx, a rate limit), so the same batch is simply tried
 * again later. `account`: it refuses this account (a bad or revoked key, an unverified
 * sending domain, a paused or suspended account), so no retry helps until the operator
 * fixes it.
 */
export interface BatchHalt {
  reason: HaltReason;
  cause: HaltCause;
  /** The provider's own words, for the operator. Never carries a credential. */
  error: string;
  /**
   * Whether the provider may have accepted some of the batch anyway (a 5xx can come after
   * the work was done). Only then must a re-send go under the same key; a refusal that
   * proves nothing was accepted lets the batch be made again from scratch.
   */
  mayHaveSent: boolean;
}

/**
 * A provider's answer to one batch: per-recipient results, or a halt that speaks for the
 * whole batch. Only the adapter can tell the two apart, since only it knows what the
 * provider's error means, so the classification stays behind the seam.
 */
export type SendBatchResult =
  | { kind: "answered"; results: PerRecipientResult[] }
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
  /** Names the caller (a send id, or a test or confirmation tag); an adapter derives a
   *  key from it when no `idempotencyKey` is given. */
  idempotencyKeyPrefix: string;
  /**
   * This batch's own idempotency key, when the caller holds one: the send loop's
   * dispatch key, the same on every re-send of the same batch and never reused for
   * another. An adapter with native idempotency sends it verbatim.
   */
  idempotencyKey?: string;
}

/**
 * How a provider behaves under the send loop, as its adapter declares it: how many
 * recipients one request takes, whether a re-sent batch is deduped and for how long, and
 * how fast it takes requests. The
 * dev simulation's provider profiles read these from the real adapters, so the two can't
 * drift.
 */
export interface ProviderTraits {
  /** Max recipients per provider call (the send loop chunks to this). One call makes at
   *  most one outbound request, which is how the send loop budgets it. */
  readonly maxBatch: number;
  /** true = safe to re-send a stuck `dispatched` row (deduped by idempotency key). */
  readonly idempotentRetry: boolean;
  /** How long the provider remembers an idempotency key, when it forgets at all. A batch
   *  whose fate is unknown is only re-sent inside this window; after it, a re-send is no
   *  longer deduped, so the batch waits for Resolve instead. */
  readonly idempotencyWindowMs?: number;
  /** The most requests a second the provider takes from this account, when it holds the
   *  sender to a rate the send loop should keep under (SES's maximum send rate). */
  readonly maxRequestRate?: number;
}

export interface EmailProvider extends ProviderTraits {
  readonly name: "fake" | "ses" | "resend";

  /** Throws only when the request got no answer at all, whose fate is then unknown. */
  sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult>;

  parseWebhook(req: Request, env: AppEnv): Promise<WebhookResult>;
}
