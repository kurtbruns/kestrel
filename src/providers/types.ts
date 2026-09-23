/** The two-method provider seam. Everything provider-specific lives behind it. */

import type { HaltReason } from "../../shared/sends";
import type { AppEnv } from "../env";
import type { RenderedEmail } from "../render/render";

export type { HaltReason, RenderedEmail };

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
  /** The provider's own words, for the operator. Never carries a credential. */
  error: string;
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

export interface SendBatchOptions {
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

export interface EmailProvider {
  readonly name: "fake" | "ses" | "resend";
  /** Max recipients per provider call (the send loop chunks to this). One call makes at
   *  most one outbound request, which is how the send loop budgets it. */
  readonly maxBatch: number;
  /** true = safe to re-send a stuck `dispatched` row (deduped by idempotency key). */
  readonly idempotentRetry: boolean;

  /** Throws only when the request got no answer at all, whose fate is then unknown. */
  sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult>;

  parseWebhook(req: Request, env: AppEnv): Promise<WebhookResult>;
}
