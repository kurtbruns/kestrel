/**
 * In-memory transport for local dev and tests. It is the ONLY transport in the
 * dev environment, so dev can never reach a real inbox. It records each message
 * with the unsubscribe sentinel already substituted — exactly what a real
 * provider would send — so tests can assert the delivered bytes.
 *
 * `idempotentRetry` is true, so it dedupes on the per-recipient idempotency key
 * (send id : email): re-sending after a crash records each recipient once (I4).
 * `failFakeSendBatch(n)` makes the next n sendBatch calls throw at the start
 * (a transient-outage stand-in) so the resume path is testable.
 */
import type { AppEnv } from "../env";
import { substituteUnsubscribe } from "../render/render";
import type {
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
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
  ): Promise<PerRecipientResult[]> {
    if (failCount > 0) {
      failCount -= 1;
      throw new Error("fake transient failure");
    }
    return recipients.map((r) => {
      const key = `${opts.idempotencyKeyPrefix}:${r.email}`;
      const existing = sentKeys.get(key);
      if (existing) {
        // Deduped: a real idempotent provider would not re-deliver.
        return { email: r.email, accepted: true, providerId: existing };
      }
      const providerId = `fake-${key}`;
      const final = substituteUnsubscribe(rendered, r.unsubscribeUrl);
      sentKeys.set(key, providerId);
      outbox.push({
        to: r.email,
        subject: final.subject,
        html: final.html,
        text: final.text,
        providerId,
        sentAt: Date.now(),
      });
      return { email: r.email, accepted: true, providerId };
    });
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
