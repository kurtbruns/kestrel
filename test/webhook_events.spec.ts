import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isSuppressed } from "../src/db/subscribers";
import type { DeliveryEvent } from "../src/providers/types";
import { currentTemplateRevision } from "../src/services/template_history";
import { applyDeliveryEvents } from "../src/services/webhook_events";

// applyDeliveryEvents() is the ONLY thing that mutates state from provider
// events, so the suppression rule (I1) is unit-tested here. The SES/Resend
// adapters both echo the recipient address in every event, so an event keyed by
// `provider_id` alone can't come through parseWebhook — it's constructed
// directly to prove the service still recovers the address from the matched
// delivery row and suppresses.

/** Seed one accepted delivery (with its parent post + send, for the FK). */
async function seedDelivery(email: string, providerId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-we','p-we','sent',?,?)",
  )
    .bind(now, now)
    .run();
  const tpl = (await currentTemplateRevision(env.DB)).id; // every send pins a revision
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, template_revision, scheduled_at) VALUES ('s-we','p-we','sent',?, '', '', '', ?, ?)",
  )
    .bind(now, tpl, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO deliveries (id, send_id, email, status, provider_id, updated_at) VALUES (?, 's-we', ?, 'accepted', ?, ?)",
  )
    .bind(`d-${providerId}`, email, providerId, now)
    .run();
}

async function deliveryEvent(providerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ event: string | null }>();
  return row?.event ?? null;
}

async function deliveryBounceKind(providerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT bounce_kind FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ bounce_kind: string | null }>();
  return row?.bounce_kind ?? null;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM suppressions"),
  ]);
});

describe("applyDeliveryEvents — suppression address recovery", () => {
  it("suppresses via the matched delivery row when a hard bounce carries only a provider id", async () => {
    await seedDelivery("idonly-hard@example.com", "msg-idonly-hard");
    const events: DeliveryEvent[] = [
      { type: "bounced", providerId: "msg-idonly-hard", hard: true },
    ];

    const applied = await applyDeliveryEvents(env.DB, events);

    expect(applied).toEqual({ applied: 1, suppressed: 1 });
    expect(await isSuppressed(env.DB, "idonly-hard@example.com")).toBe(true);
    expect(await deliveryEvent("msg-idonly-hard")).toBe("bounced");
    // The permanent/transient signal is frozen on the row for the record view (SPEC §8).
    expect(await deliveryBounceKind("msg-idonly-hard")).toBe("hard");
  });

  it("suppresses via the matched delivery row when a complaint carries only a provider id", async () => {
    await seedDelivery("idonly-complaint@example.com", "msg-idonly-cmp");

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-idonly-cmp" },
    ]);

    expect(applied.suppressed).toBe(1);
    expect(await isSuppressed(env.DB, "idonly-complaint@example.com")).toBe(true);
  });

  it("does not suppress a soft bounce carrying only a provider id", async () => {
    await seedDelivery("idonly-soft@example.com", "msg-idonly-soft");

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-idonly-soft", hard: false },
    ]);

    expect(applied.suppressed).toBe(0);
    expect(await isSuppressed(env.DB, "idonly-soft@example.com")).toBe(false);
    // Still recorded on the row — a soft bounce is observed, just not suppressed.
    expect(await deliveryEvent("msg-idonly-soft")).toBe("bounced");
    expect(await deliveryBounceKind("msg-idonly-soft")).toBe("soft");
  });

  it("records but does not suppress when a provider-id-only event matches no row", async () => {
    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-unknown", hard: true },
    ]);

    // The event is counted, but there is no address to suppress.
    expect(applied).toEqual({ applied: 1, suppressed: 0 });
  });

  it("still suppresses from the event's own address when present (unchanged path)", async () => {
    // No delivery row: the address comes straight from the event, as before.
    const applied = await applyDeliveryEvents(env.DB, [
      { type: "complained", email: "direct@example.com" },
    ]);

    expect(applied.suppressed).toBe(1);
    expect(await isSuppressed(env.DB, "direct@example.com")).toBe(true);
  });
});
