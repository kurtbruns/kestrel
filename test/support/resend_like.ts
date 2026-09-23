/**
 * A transport that behaves like Resend where it matters to I4: batches of at most 100,
 * and idempotency per key, not per recipient. A key seen before with the identical
 * payload returns the first answer and mails no one; the same key with a different
 * payload is refused (Resend's 409). So a batch re-made with a new key re-mails its
 * recipients here exactly as it would in production, where the plain fake would hide it.
 */
import type { AppEnv } from "../../src/env";
import type {
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  WebhookResult,
} from "../../src/providers/types";

export class ResendLikeProvider implements EmailProvider {
  readonly name = "resend" as const;
  readonly maxBatch: number = 100;
  readonly idempotentRetry: boolean = true;

  /** Every message actually mailed. */
  readonly mailed: { to: string; key: string }[] = [];
  /** Provider requests made. */
  requests = 0;
  /** Accept (and mail) the next n batches, then throw as if the answer was lost. */
  loseAnswers = 0;
  /** Answer the next n batches with a 429 for every recipient, mailing no one. */
  rateLimit = 0;

  private readonly seen = new Map<string, { payload: string; results: PerRecipientResult[] }>();

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<PerRecipientResult[]> {
    this.requests += 1;
    if (recipients.length > this.maxBatch) {
      throw new Error(`resend-like: ${recipients.length} recipients in one batch`);
    }
    if (this.rateLimit > 0) {
      this.rateLimit -= 1;
      return recipients.map((r) => ({
        email: r.email,
        accepted: false,
        retryable: true,
        error: "resend batch 429: rate_limit_exceeded",
      }));
    }
    const key = opts.idempotencyKey ?? `${opts.idempotencyKeyPrefix}:${recipients.length}`;
    const payload = JSON.stringify([rendered, recipients]);
    const prior = this.seen.get(key);
    if (prior) {
      if (prior.payload !== payload) {
        return recipients.map((r) => ({
          email: r.email,
          accepted: false,
          retryable: false,
          error: "resend batch 409: invalid_idempotent_request",
        }));
      }
      return prior.results;
    }
    const results = recipients.map((r): PerRecipientResult => {
      this.mailed.push({ to: r.email, key });
      return { email: r.email, accepted: true, providerId: `re_${this.mailed.length}` };
    });
    this.seen.set(key, { payload, results });
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1;
      throw new Error("connection reset after the batch was accepted");
    }
    return results;
  }

  timesMailed(email: string): number {
    return this.mailed.filter((m) => m.to === email).length;
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
