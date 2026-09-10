/** Shared subscribe orchestration: create/re-arm a subscriber and send the
 *  double opt-in confirmation through the provider seam. Used by both the public
 *  form and the authed API. */

import * as subscribers from "../db/subscribers";
import { confirmationEmail } from "../emails/system";
import { getProvider } from "../providers";
import type { RequestContext } from "../router";

export async function requestSubscription(
  c: RequestContext,
  email: string,
): Promise<{ subscriber: subscribers.SubscriberRow; action: subscribers.SubscribeAction }> {
  const { subscriber, action } = await subscribers.subscribe(c.env.DB, email);
  if (action !== "already_confirmed") {
    const provider = getProvider(c.config, c.env);
    const confirmUrl = `${c.config.appOrigin}/confirm?token=${subscriber.confirm_token}`;
    await provider.sendBatch(
      confirmationEmail(confirmUrl),
      [{ email: subscriber.email, unsubscribeUrl: "" }],
      {
        idempotencyKeyPrefix: `confirm-${subscriber.id}`,
      },
    );
  }
  return { subscriber, action };
}
