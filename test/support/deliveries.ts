/**
 * A delivery row for a webhook receipt to land on, without running a send: the provider
 * specs and the receipt service's spec need one recipient's row with a known provider id,
 * and nothing else a send would write.
 */

import { env } from "cloudflare:workers";

/** The send every seeded delivery belongs to, so a spec can read its counters. */
export const SEEDED_SEND_ID = "s-receipts";

/**
 * Seed one accepted delivery, and the post and send it belongs to (the foreign keys are
 * enforced here). The parents are shared across calls; `providerId` is null for a
 * recipient settled as sent without the provider's id.
 */
export async function seedDelivery(email: string, providerId: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-receipts', 'p-receipts', 'sent', ?, ?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, 'p-receipts', 'sent', ?, '', '', '', ?)",
    ).bind(SEEDED_SEND_ID, now, now),
    env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, provider_id, updated_at) VALUES (?, ?, 'accepted', ?, ?)",
    ).bind(SEEDED_SEND_ID, email, providerId, now),
  ]);
}

/** The outcome a receipt recorded on the delivery with this provider id, or null. The
 *  receipt lands in `event` and leaves the send loop's own `status` alone. */
export async function deliveryEvent(providerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ event: string | null }>();
  return row?.event ?? null;
}
