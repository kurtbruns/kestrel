/**
 * How a notification reaches the publisher (SPEC §8): through the newsletter's own provider,
 * the one path, sent as Kestrel on the publication's behalf (`notificationSender`). A
 * dev-shaped env gets the in-memory fake instead, so development can never reach a real
 * inbox. The exceptions are local dev's send simulation and its not-connected preview, which
 * get the provider over the simulated or not-connected adapter, as a deployment does, so a
 * notification meets what an email meets there and the preview carries nothing.
 *
 * A notifier only ever sends one message to one address, the publisher's. It is never
 * handed a subscriber, a send's audience, or a delivery row.
 */

import type { Sender } from "../../shared/publication";
import type { AppEnv, Config } from "../env";
import { getProvider, perRecipient } from "../providers";
import type { RenderedEmail } from "../render/render";

import { type Contacts, contactOutcome } from "../services/sending";
import { FakeNotifier } from "./fake";

export interface Notifier {
  /** Which notifier it is, for the log line of each delivery. */
  readonly channel: "provider" | "fake";
  /**
   * Deliver one message to `to`. `key` names the notification, so a notifier that
   * records by it (the fake) never records the same one twice.
   * Throws with the provider's own words when it is not delivered. The provider notifier adds
   * what its answer says about the account to `contacts` (SPEC §13), which the caller records.
   */
  send(to: string, message: RenderedEmail, key: string, contacts: Contacts): Promise<void>;
}

/** Whether notifications go to the in-memory fake: a dev-shaped env with neither the send
 *  simulation nor the not-connected preview standing in for a provider. */
export function notifiesFake(config: Config): boolean {
  return config.devShaped && config.simulation === null && !config.notConnectedPreview;
}

/** The notifier for this deployment. `sender` is who a notification goes out as
 *  (`notificationSenderFrom`), resolved once by the caller from the settings it already holds. */
export function getNotifier(config: Config, env: AppEnv, sender: Sender): Notifier {
  return notifiesFake(config) ? new FakeNotifier() : new ProviderNotifier(config, env, sender);
}

/**
 * The newsletter's own provider. It cannot carry a notification that the provider is
 * refusing the account, which is exactly when that one matters; the refusal still shows on
 * the status surface, and the setup guide's Cloudflare Monitors tell the operator (SPEC §12).
 * Its answer is an email's answer like any other, so it records whether email is getting out.
 */
export class ProviderNotifier implements Notifier {
  readonly channel = "provider" as const;

  constructor(
    private readonly config: Config,
    private readonly env: AppEnv,
    private readonly sender: Sender,
  ) {}

  async send(to: string, message: RenderedEmail, key: string, contacts: Contacts): Promise<void> {
    const provider = getProvider(this.config, this.env, this.sender);
    // Transactional, like the confirmation email: no unsubscribe link, since it goes to
    // the publisher about their own sends and never to the list.
    const recipients = [{ email: to, unsubscribeUrl: "" }];
    const answer = await provider.sendBatch(message, recipients, {
      purpose: "notification",
      tag: `notify-${key}`,
    });
    contacts.add("notification", contactOutcome(answer), Date.now());
    const [result] = perRecipient(answer, recipients);
    if (!result?.accepted) {
      throw new Error(result?.error ?? "the provider gave no answer for the recipient");
    }
  }
}
