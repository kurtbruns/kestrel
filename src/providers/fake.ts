/**
 * In-memory transport for local dev and tests. It is the ONLY transport in the
 * dev environment, so dev can never reach a real inbox. It records each message
 * with the unsubscribe sentinel already substituted — exactly what a real
 * provider would send — so tests can assert the delivered bytes.
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

// Module-level outbox: shared within the Worker isolate, inspected via the
// guarded /api/dev/outbox route. Not durable — that's the point.
const outbox: FakeMessage[] = [];

export function fakeOutbox(): readonly FakeMessage[] {
  return outbox;
}

export function clearFakeOutbox(): void {
  outbox.length = 0;
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
    return recipients.map((r) => {
      const final = substituteUnsubscribe(rendered, r.unsubscribeUrl);
      const providerId = `fake-${opts.idempotencyKeyPrefix}-${r.email}`;
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
