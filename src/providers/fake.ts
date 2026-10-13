/**
 * In-memory transport for local dev and tests. It is the ONLY transport in the
 * dev environment, so dev can never reach a real inbox. It records each message
 * with the unsubscribe sentinel already substituted — exactly what a real
 * provider would send — so tests can assert the delivered bytes. The dev send
 * simulation records into the same outbox (`deliverToOutbox`), so `GET /api/dev/outbox`
 * shows everything a local server sent, simulated or not.
 *
 * It records each recipient once under the batch's key (the send loop's dispatch key, else
 * the caller's tag), and a recipient sent again under a different key shows up twice, as
 * it would at a real provider.
 * `failFakeSendBatch(n)` makes the next n sendBatch calls answer as a provider that is
 * down (an outage halt, nothing sent) so the resume path is testable.
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
const sentKeys = new Map<string, string>(); // batch key + address -> providerId
let failCount = 0;

export function fakeOutbox(): readonly FakeMessage[] {
  return outbox;
}

export function clearFakeOutbox(): void {
  outbox.length = 0;
  sentKeys.clear();
  failCount = 0;
}

/** Make the next `n` sendBatch calls answer with an outage, sending nothing. */
export function failFakeSendBatch(n: number): void {
  failCount = n;
}

/**
 * Deliver each recipient's message into the outbox, as a real provider would send it, and
 * accept them all. Once per recipient under the batch's key (the dispatch key, else the
 * caller's tag).
 */
export function deliverToOutbox(
  rendered: RenderedEmail,
  recipients: Recipient[],
  opts: SendBatchOptions,
): PerRecipientResult[] {
  return recipients.map((r) => {
    const key = `${opts.batchKey ?? opts.tag}:${r.email}`;
    const existing = sentKeys.get(key);
    if (existing) {
      return { email: r.email, accepted: true as const, providerId: existing };
    }
    // Named by the caller and address, not the key, so a test can predict it.
    const providerId = `fake-${opts.tag}:${r.email}`;
    const final = substituteRecipient(rendered, {
      ".Email.UnsubscribeURL": r.unsubscribeUrl,
      ".Email.SentTo": r.email,
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

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    if (failCount > 0) {
      failCount -= 1;
      return {
        kind: "halted",
        halt: { reason: "unavailable", cause: "outage", error: "fake transient failure" },
      };
    }
    return { kind: "answered", results: deliverToOutbox(rendered, recipients, opts) };
  }

  async parseWebhook(_req: Request, _env: AppEnv): Promise<WebhookResult> {
    return { events: [], response: new Response("ok") };
  }
}
