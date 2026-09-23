/** The two-method provider seam. Everything provider-specific lives behind it. */
import type { AppEnv } from "../env";
import type { RenderedEmail } from "../render/render";

export type { RenderedEmail };

export interface Recipient {
  email: string;
  /** Per-recipient unsubscribe URL that replaces the sentinel at send time. */
  unsubscribeUrl: string;
}

export type PerRecipientResult =
  | { email: string; accepted: true; providerId: string }
  | { email: string; accepted: false; retryable: boolean; error: string };

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

  sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<PerRecipientResult[]>;

  parseWebhook(req: Request, env: AppEnv): Promise<WebhookResult>;
}
