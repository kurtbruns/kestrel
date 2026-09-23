/**
 * In-memory transport for local dev and tests. It is the ONLY transport in the
 * dev environment, so dev can never reach a real inbox. It records each message
 * with the unsubscribe sentinel already substituted — exactly what a real
 * provider would send — so tests can assert the delivered bytes.
 *
 * `idempotentRetry` is true, so it dedupes per recipient under the batch's key (the
 * send loop's dispatch key, else the caller's prefix): re-sending a batch after a crash
 * records each recipient once (I4), and a recipient re-sent under a different key would
 * show up twice, as it would at a real provider.
 * `failFakeSendBatch(n)` makes the next n sendBatch calls throw at the start
 * (a transient-outage stand-in) so the resume path is testable.
 */
import type { AppEnv } from "../env";
import { substituteRecipient } from "../render/render";
import type {
  EmailProvider,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "./types";

export interface FakeMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  providerId: string;
  sentAt: number;
}

const outbox: FakeMessage[] = [];
const sentKeys = new Map<string, string>(); // idempotency key -> providerId
let failCount = 0;

export function fakeOutbox(): readonly FakeMessage[] {
  return outbox;
}

export function clearFakeOutbox(): void {
  outbox.length = 0;
  sentKeys.clear();
  failCount = 0;
}

/** Make the next `n` sendBatch calls throw (simulates a transient outage). */
export function failFakeSendBatch(n: number): void {
  failCount = n;
}

export class FakeProvider implements EmailProvider {
  readonly name = "fake" as const;
  readonly maxBatch = Number.MAX_SAFE_INTEGER;
  readonly idempotentRetry = true;

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    if (failCount > 0) {
      failCount -= 1;
      throw new Error("fake transient failure");
    }
    const results = recipients.map((r) => {
      const key = `${opts.idempotencyKey ?? opts.idempotencyKeyPrefix}:${r.email}`;
      const existing = sentKeys.get(key);
      if (existing) {
        // Deduped: a real idempotent provider would not re-deliver.
        return { email: r.email, accepted: true as const, providerId: existing };
      }
      // Named by the caller and address, not the key, so a test can predict it.
      const providerId = `fake-${opts.idempotencyKeyPrefix}:${r.email}`;
      const final = substituteRecipient(rendered, {
        "email.unsubscribeUrl": r.unsubscribeUrl,
        "email.sentTo": r.email,
      });
      sentKeys.set(key, providerId);
      outbox.push({
        to: r.email,
        subject: final.subject,
        html: final.html,
        text: final.text,
        providerId,
        sentAt: Date.now(),
      });
      return { email: r.email, accepted: true as const, providerId };
    });
    return { kind: "answered", results };
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
