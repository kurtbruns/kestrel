/**
 * The in-memory notification channel for local dev and tests, as `providers/fake.ts` is
 * for sends: it records each notification and delivers nothing, so development can never
 * reach a real inbox. `notify.ts` logs each delivery (`notify.sent`, channel `fake`), without
 * the address it went to. `failFakeNotify(n)` makes the next n deliveries throw, so a failing
 * channel is testable.
 */

import type { RenderedEmail } from "../render/render";
import type { Notifier } from "./channel";

export interface FakeNotification {
  to: string;
  subject: string;
  text: string;
  html: string;
  key: string;
  sentAt: number;
}

const outbox: FakeNotification[] = [];
let failCount = 0;

export function fakeNotifications(): readonly FakeNotification[] {
  return outbox;
}

export function clearFakeNotifications(): void {
  outbox.length = 0;
  failCount = 0;
}

/** Make the next `n` deliveries throw (a channel refusing, say an unverified address). */
export function failFakeNotify(n: number): void {
  failCount = n;
}

export class FakeNotifier implements Notifier {
  readonly channel = "fake" as const;

  async send(to: string, message: RenderedEmail, key: string): Promise<void> {
    if (failCount > 0) {
      failCount -= 1;
      throw new Error("fake notification failure");
    }
    outbox.push({ to, ...message, key, sentAt: Date.now() });
  }
}
