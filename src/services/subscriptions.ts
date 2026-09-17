/** Shared subscribe orchestration: create/re-arm a subscriber and send the
 *  double opt-in confirmation through the provider seam. Used by both the public
 *  form and the authed API. */

import { getSettings, resolveConfirmationEmail } from "../db/settings";
import * as subscribers from "../db/subscribers";
import { confirmationEmail } from "../emails/system";
import { getProvider } from "../providers";
import { resolveBranding } from "../render/template_engine";
import type { RequestContext } from "../router";

export async function requestSubscription(
  c: RequestContext,
  email: string,
): Promise<{ subscriber: subscribers.SubscriberRow; action: subscribers.SubscribeAction }> {
  const { subscriber, action } = await subscribers.subscribe(c.env.DB, email);
  if (action !== "already_confirmed") {
    const provider = getProvider(c.config, c.env);
    const settings = await getSettings(c.env.DB);
    const copy = resolveConfirmationEmail(settings);
    // The branded layout reuses the same publication identity the issue render does
    // (name falls back to the From display name), so the two never drift.
    const branding = resolveBranding(settings, c.config);
    const identity = { name: branding.name, tagline: branding.tagline, logoUrl: branding.logoUrl };
    const confirmUrl = `${c.config.appOrigin}/confirm?token=${subscriber.confirm_token}`;
    await provider.sendBatch(
      confirmationEmail(confirmUrl, copy, identity),
      [{ email: subscriber.email, unsubscribeUrl: "" }],
      {
        idempotencyKeyPrefix: `confirm-${subscriber.id}`,
      },
    );
  }
  return { subscriber, action };
}
