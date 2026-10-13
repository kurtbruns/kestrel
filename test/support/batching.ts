/**
 * A transport that batches the way a real provider does where it matters to I4: up to 100
 * recipients a request, every recipient it mails counted, and no idempotency key, so a
 * request whose answer is lost leaves its recipients in flight for Resolve (SPEC §12). An
 * outage, a rate limit, or an account refusal answers the whole batch as a halt, mailing
 * no one, as the SES adapter reports them.
 *
 * `SesLikeProvider` is the one-recipient shape: SES on an account allowed fewer than ten a
 * second, the one shape whose requests the send loop groups.
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

export class BatchProvider implements EmailProvider {
  readonly name = "ses" as const;
  readonly maxBatch: number = 100;

  /** Every message actually mailed. */
  readonly mailed: { to: string; key: string }[] = [];
  /** Provider requests made. */
  requests = 0;
  /** Accept (and mail) the next n batches, then throw as if the answer was lost. */
  loseAnswers = 0;
  /** Answer the next n batches with a 503, mailing no one (the provider is down). */
  outage = 0;
  /** Answer the next n batches with a 429, mailing no one. */
  rateLimit = 0;
  /** While set, refuse every batch for this account-level reason (a revoked key, say). */
  refuse: string | null = null;

  async sendBatch(
    _rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    this.requests += 1;
    if (recipients.length > this.maxBatch) {
      throw new Error(`batching: ${recipients.length} recipients in one batch`);
    }
    if (this.refuse) {
      return {
        kind: "halted",
        halt: { reason: "account", cause: "credentials", error: this.refuse },
      };
    }
    if (this.outage > 0) {
      this.outage -= 1;
      return {
        kind: "halted",
        halt: { reason: "unavailable", cause: "outage", error: "ses 503 ServiceUnavailable" },
      };
    }
    if (this.rateLimit > 0) {
      this.rateLimit -= 1;
      return {
        kind: "halted",
        halt: {
          reason: "unavailable",
          cause: "rate_limit",
          error: "ses 429 TooManyRequestsException: Maximum sending rate exceeded.",
        },
      };
    }
    const key = opts.batchKey ?? `${opts.tag}:${recipients.length}`;
    const results = recipients.map((r): PerRecipientResult => {
      this.mailed.push({ to: r.email, key });
      return { email: r.email, accepted: true, providerId: `msg_${this.mailed.length}` };
    });
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

/** One recipient a request: SES on an account allowed fewer than ten a second. */
export class SesLikeProvider extends BatchProvider {
  override readonly maxBatch: number = 1;
}
