/**
 * The channels a notification to the publisher can go through (SPEC §8), behind one
 * method. Cloudflare's own email is the channel when the `NOTIFY` binding is declared,
 * because it does not depend on the newsletter's provider, and so still arrives when that
 * provider is refusing the account; the provider is the fallback when it is not. The
 * choice is deploy config (`getConfig`), never a preference, and a dev-shaped env always
 * gets the in-memory fake, so development can never reach a real inbox.
 *
 * A channel only ever sends one message to one address, the publisher's. It is never
 * handed a subscriber, a send's audience, or a delivery row.
 */

import type { AppEnv, Config, NotifyChannel } from "../env";
import { getProvider, perRecipient } from "../providers";
import type { RenderedEmail } from "../render/render";
import { FakeNotifier } from "./fake";

export interface Notifier {
  readonly channel: NotifyChannel;
  /**
   * Deliver one message to `to`. `key` names the notification, so a channel that
   * deduplicates (the provider's idempotency key) never delivers the same one twice.
   * Throws with the channel's own words when it is not delivered.
   */
  send(to: string, message: RenderedEmail, key: string): Promise<void>;
}

export function getNotifier(config: Config, env: AppEnv): Notifier {
  switch (config.notifyChannel) {
    case "cloudflare":
      if (env.NOTIFY) {
        return new CloudflareNotifier(env.NOTIFY, config.notifyFrom);
      }
      // getConfig picks this channel only when the binding is declared.
      throw new Error("the NOTIFY binding is not declared");
    case "provider":
      return new ProviderNotifier(config, env);
    default:
      return new FakeNotifier();
  }
}

/** A `Name <address>` sender split for the binding, or the bare address as given. */
function parseFrom(from: string): string | EmailAddress {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m?.[2] ? { name: m[1] ?? "", email: m[2] } : from.trim();
}

/**
 * Cloudflare's `send_email` binding. Cloudflare delivers only to a destination address
 * verified in the account (or to anyone once a sending domain is onboarded), from an
 * address on a domain onboarded to its email sending; either refusal throws, and its
 * message is what the settings surface shows.
 */
export class CloudflareNotifier implements Notifier {
  readonly channel = "cloudflare" as const;

  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
  ) {}

  async send(to: string, message: RenderedEmail): Promise<void> {
    await this.binding.send({
      from: parseFrom(this.from),
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

/**
 * The newsletter's own provider, for a deployment without the binding. It cannot carry a
 * notification that the provider is refusing the account, which is exactly when that one
 * matters; the setup guide says so, and the refusal still shows on the status surface.
 */
export class ProviderNotifier implements Notifier {
  readonly channel = "provider" as const;

  constructor(
    private readonly config: Config,
    private readonly env: AppEnv,
  ) {}

  async send(to: string, message: RenderedEmail, key: string): Promise<void> {
    const provider = getProvider(this.config, this.env);
    // Transactional, like the confirmation email: no unsubscribe link, since it goes to
    // the publisher about their own sends and never to the list.
    const recipients = [{ email: to, unsubscribeUrl: "" }];
    const answer = await provider.sendBatch(message, recipients, {
      purpose: "notification",
      idempotencyKeyPrefix: `notify-${key}`,
    });
    const [result] = perRecipient(answer, recipients);
    if (!result?.accepted) {
      throw new Error(result?.error ?? "the provider gave no answer for the recipient");
    }
  }
}
