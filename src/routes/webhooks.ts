/**
 * Public provider webhooks. NOT behind requireAuth — a provider cannot present
 * our admin credentials; authenticity is established by the provider's own
 * signature, verified inside the adapter's `parseWebhook`.
 *
 *   POST /webhooks/ses     → SNS handshake + SES bounce/complaint/delivery events
 *
 * The route is deliberately thin: the active provider (from config) parses and verifies
 * the request and returns both the normalized events and the exact response to send
 * back; this handler only applies the events to the database, and keeps a report it refused
 * for naming another topic, for the warning that reports aren't reaching the app (SPEC §13).
 */

import { refusedTopicStatement } from "../db/sending";
import { errorFields, log } from "../lib/log";
import { getProvider } from "../providers";
import type { RequestContext } from "../router";
import { applyDeliveryEvents } from "../services/webhook_events";

async function handle(c: RequestContext): Promise<Response> {
  // Null sender: this adapter parses the webhook and never sends.
  const provider = getProvider(c.config, c.env, null);
  const { events, response, refusedTopic } = await provider.parseWebhook(c.req, c.env);
  // Before the events are applied: one line a request, even a handshake or a refused
  // signature, so a provider that has stopped calling is visible by the silence.
  log.info("webhook.received", {
    provider: provider.name,
    status: response.status,
    events: events.length,
    delivered: events.filter((e) => e.type === "delivered").length,
    bounced: events.filter((e) => e.type === "bounced").length,
    complained: events.filter((e) => e.type === "complained").length,
  });
  if (events.length > 0) {
    await applyDeliveryEvents(c.env.DB, events);
  }
  if (refusedTopic) {
    try {
      await refusedTopicStatement(c.env.DB, refusedTopic, Date.now()).run();
    } catch (err) {
      // The refusal is already logged, and SNS gets its 403 either way.
      log.warn("webhook.unrecorded", { what: "refused_topic", ...errorFields(err) });
    }
  }
  return response;
}

export function ses(c: RequestContext): Promise<Response> {
  return handle(c);
}
