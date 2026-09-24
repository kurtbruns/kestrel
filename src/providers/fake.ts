/**
 * In-memory transport for local dev and tests. It is the ONLY transport in the
 * dev environment, so dev can never reach a real inbox. It records each message
 * with the unsubscribe sentinel already substituted — exactly what a real
 * provider would send — so tests can assert the delivered bytes. The dev send
 * simulation records into the same outbox (`deliverToOutbox`), so `GET /api/dev/outbox`
 * shows everything a local server sent, simulated or not.
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
  PerRecipientResult,
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

/**
 * Deliver each recipient's message into the outbox, as a real provider would send it, and
 * accept them all. Once per recipient under the batch's key (the dispatch key, else the
 * caller's prefix): a batch re-sent under its key is deduped, as at an idempotent provider.
 */
export function deliverToOutbox(
  rendered: RenderedEmail,
  recipients: Recipient[],
  opts: SendBatchOptions,
): PerRecipientResult[] {
  return recipients.map((r) => {
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
    return { kind: "answered", results: deliverToOutbox(rendered, recipients, opts) };
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
