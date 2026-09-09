/**
 * Public provider webhooks. NOT behind requireAuth — a provider cannot present
 * our admin credentials; authenticity is established by the provider's own
 * signature, verified inside the adapter's `parseWebhook`.
 *
 *   POST /webhooks/ses  → SNS handshake + SES bounce/complaint/delivery events
 *
 * The route is deliberately thin: the active provider parses + verifies and
 * returns both the normalized events and the exact response to send back; this
 * handler only applies the events to the database.
 */
import type { RequestContext } from "../router";
import { getProvider } from "../providers";
import { applyDeliveryEvents } from "../services/webhook_events";

export async function ses(c: RequestContext): Promise<Response> {
  const provider = getProvider(c.config, c.env);
  const { events, response } = await provider.parseWebhook(c.req, c.env);
  if (events.length > 0) {
    await applyDeliveryEvents(c.env.DB, events);
  }
  return response;
}
