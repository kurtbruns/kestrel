/**
 * Public provider webhooks. NOT behind requireAuth — a provider cannot present
 * our admin credentials; authenticity is established by the provider's own
 * signature, verified inside the adapter's `parseWebhook`.
 *
 *   POST /webhooks/ses     → SNS handshake + SES bounce/complaint/delivery events
 *   POST /webhooks/resend  → Svix-signed Resend delivery/bounce/complaint events
 *
 * Both routes are deliberately thin and identical: the active provider (from
 * config) parses + verifies the request and returns both the normalized events
 * and the exact response to send back; this handler only applies the events to
 * the database. The distinct paths exist so each provider has its own public
 * endpoint to register with; the request is handed to whichever transport is
 * configured.
 */
import type { RequestContext } from "../router";
import { getProvider } from "../providers";
import { applyDeliveryEvents } from "../services/webhook_events";

async function handle(c: RequestContext): Promise<Response> {
  const provider = getProvider(c.config, c.env);
  const { events, response } = await provider.parseWebhook(c.req, c.env);
  if (events.length > 0) {
    await applyDeliveryEvents(c.env.DB, events);
  }
  return response;
}

export function ses(c: RequestContext): Promise<Response> {
  return handle(c);
}

export function resend(c: RequestContext): Promise<Response> {
  return handle(c);
}
