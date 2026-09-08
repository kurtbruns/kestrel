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
  /** Send id; the adapter forms a per-recipient idempotency key from it. */
  idempotencyKeyPrefix: string;
}

export interface EmailProvider {
  readonly name: "fake" | "ses" | "resend";
  /** Max recipients per provider call (the send loop chunks to this). */
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
