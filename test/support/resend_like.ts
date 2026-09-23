/**
 * A transport that behaves like Resend where it matters to I4: batches of at most 100,
 * and idempotency per key, not per recipient. A key seen before with the identical
 * payload returns the first answer and mails no one; the same key with a different
 * payload is refused (Resend's 409). So a batch re-made with a new key re-mails its
 * recipients here exactly as it would in production, where the plain fake would hide it.
 * A rate limit or an account refusal answers the whole batch as a halt, mailing no one,
 * as the real adapter reports them.
 */
import type { AppEnv } from "../../src/env";
import type {
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "../../src/providers/types";

export class ResendLikeProvider implements EmailProvider {
  readonly name = "resend" as const;
  readonly maxBatch: number = 100;
  readonly idempotentRetry: boolean = true;
  /** Resend remembers a key for 24 hours; the adapter allows 23. */
  readonly idempotencyWindowMs: number | undefined = 23 * 60 * 60 * 1000;

  /** Every message actually mailed. */
  readonly mailed: { to: string; key: string }[] = [];
  /** Provider requests made. */
  requests = 0;
  /** Accept (and mail) the next n batches, then throw as if the answer was lost. */
  loseAnswers = 0;
  /** Fail the next n requests outright, before anything is mailed (the provider is down). */
  outage = 0;
  /** Answer the next n batches with a 429, mailing no one. */
  rateLimit = 0;
  /** Answer the next n batches with a 503 after mailing them, as a 5xx that came after the
   *  work was done would: the batch's fate is unknown to the loop. */
  failAfterSending = 0;
  /** While set, refuse every batch for this account-level reason (a revoked key, say). */
  refuse: string | null = null;

  private readonly seen = new Map<string, { payload: string; results: PerRecipientResult[] }>();

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    this.requests += 1;
    if (recipients.length > this.maxBatch) {
      throw new Error(`resend-like: ${recipients.length} recipients in one batch`);
    }
    if (this.outage > 0) {
      this.outage -= 1;
      throw new Error("connection refused");
    }
    if (this.refuse) {
      return {
        kind: "halted",
        halt: { reason: "account", cause: "credentials", error: this.refuse, mayHaveSent: false },
      };
    }
    if (this.rateLimit > 0) {
      this.rateLimit -= 1;
      return {
        kind: "halted",
        halt: {
          reason: "unavailable",
          cause: "rate_limit",
          error: "resend batch 429: rate_limit_exceeded",
          mayHaveSent: false,
        },
      };
    }
    const key = opts.idempotencyKey ?? `${opts.idempotencyKeyPrefix}:${recipients.length}`;
    const payload = JSON.stringify([rendered, recipients]);
    const prior = this.seen.get(key);
    if (prior) {
      if (prior.payload !== payload) {
        return {
          kind: "answered",
          results: recipients.map((r) => ({
            email: r.email,
            accepted: false,
            retryable: false,
            error: "resend batch 409: invalid_idempotent_request",
          })),
        };
      }
      return { kind: "answered", results: prior.results };
    }
    const results = recipients.map((r): PerRecipientResult => {
      this.mailed.push({ to: r.email, key });
      return { email: r.email, accepted: true, providerId: `re_${this.mailed.length}` };
    });
    this.seen.set(key, { payload, results });
    if (this.failAfterSending > 0) {
      this.failAfterSending -= 1;
      return {
        kind: "halted",
        halt: { reason: "unavailable", cause: "outage", error: "Resend 503", mayHaveSent: true },
      };
    }
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1;
      throw new Error("connection reset after the batch was accepted");
    }
    return { kind: "answered", results };
  }

  timesMailed(email: string): number {
    return this.mailed.filter((m) => m.to === email).length;
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
