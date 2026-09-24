import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isSuppressed } from "../src/db/subscribers";
import type { DeliveryEvent } from "../src/providers/types";
import { applyDeliveryEvents } from "../src/services/webhook_events";

// applyDeliveryEvents() is the ONLY thing that mutates state from provider
// events, so the suppression rule (I1) is unit-tested here. The SES/Resend
// adapters both echo the recipient address in every event, so an event keyed by
// `provider_id` alone can't come through parseWebhook — it's constructed
// directly to prove the service still recovers the address from the matched
// delivery row and suppresses.

/** Seed one accepted delivery (with its parent post + send, for the FK). */
async function seedDelivery(
  email: string,
  providerId: string | null,
  id = `d-${providerId}`,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-we','p-we','sent',?,?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s-we','p-we','sent',?, '', '', '', ?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO deliveries (id, send_id, email, status, provider_id, updated_at) VALUES (?, 's-we', ?, 'accepted', ?, ?)",
  )
    .bind(id, email, providerId, now)
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
    // A fresh send each test, so its counters start at zero.
    env.DB.prepare("DELETE FROM sends WHERE id = 's-we'"),
  ]);
});

describe("applyDeliveryEvents: suppression address recovery", () => {
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

async function sendCounters(): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    "SELECT c_accepted, c_delivered, c_bounced, c_complained FROM sends WHERE id = 's-we'",
  ).first<Record<string, number>>();
  return row!;
}

describe("applyDeliveryEvents: matching the right delivery", () => {
  it("leaves every real record untouched for a test send's events", async () => {
    // The publisher is on their own list, and a test send to them has no delivery row.
    await seedDelivery("publisher@example.com", "msg-real");
    const before = await sendCounters();

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-test", email: "publisher@example.com" },
      { type: "bounced", providerId: "msg-test", email: "publisher@example.com", hard: false },
    ]);

    expect(applied.suppressed).toBe(0);
    expect(await deliveryEvent("msg-real")).toBeNull();
    expect(await sendCounters()).toEqual(before);
  });

  it("lands a receipt on a recipient resolved as sent, which has no provider id", async () => {
    await seedDelivery("resolved@example.com", null, "d-resolved");
    const outcome = () =>
      env.DB.prepare("SELECT event FROM deliveries WHERE id = 'd-resolved'").first<{
        event: string | null;
      }>();

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-real-id", email: "resolved@example.com" },
    ]);
    expect((await outcome())?.event).toBe("delivered");

    // A complaint days later still lands, and ranks over the delivery.
    await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-real-id", email: "resolved@example.com" },
    ]);
    expect((await outcome())?.event).toBe("complained");
    expect(await sendCounters()).toMatchObject({ c_delivered: 0, c_complained: 1 });
  });

  it("falls back to the address only when the event carries no provider id", async () => {
    await seedDelivery("noid@example.com", "msg-noid");

    await applyDeliveryEvents(env.DB, [{ type: "delivered", email: "NoId@Example.com" }]);

    expect(await deliveryEvent("msg-noid")).toBe("delivered");
  });
});

describe("applyDeliveryEvents: a worse outcome is never replaced by a better one", () => {
  it("keeps complained when delivered arrives after it", async () => {
    await seedDelivery("order@example.com", "msg-order");

    await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-order" },
      { type: "delivered", providerId: "msg-order" },
    ]);

    expect(await deliveryEvent("msg-order")).toBe("complained");
    expect(await sendCounters()).toMatchObject({ c_delivered: 0, c_complained: 1 });
  });

  it("keeps complained over a later bounce, and a bounce over a later delivered", async () => {
    await seedDelivery("cmp@example.com", "msg-cmp");
    await seedDelivery("bnc@example.com", "msg-bnc");

    await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-cmp" },
      { type: "bounced", providerId: "msg-cmp", hard: true },
      { type: "bounced", providerId: "msg-bnc", hard: false },
      { type: "delivered", providerId: "msg-bnc" },
    ]);

    expect(await deliveryEvent("msg-cmp")).toBe("complained");
    expect(await deliveryEvent("msg-bnc")).toBe("bounced");
    expect(await sendCounters()).toMatchObject({ c_delivered: 0, c_bounced: 1, c_complained: 1 });
  });

  it("lets a worse outcome replace a better one", async () => {
    await seedDelivery("up@example.com", "msg-up");

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-up" },
      { type: "bounced", providerId: "msg-up", hard: false },
      { type: "bounced", providerId: "msg-up", hard: true },
      { type: "bounced", providerId: "msg-up", hard: false },
    ]);

    expect(await deliveryEvent("msg-up")).toBe("bounced");
    // A later soft bounce does not undo the hard one that suppressed the address.
    expect(await deliveryBounceKind("msg-up")).toBe("hard");
    expect(await sendCounters()).toMatchObject({ c_delivered: 0, c_bounced: 1 });
  });
});

describe("applyDeliveryEvents: suppression casing", () => {
  it("suppresses subscriber bob@x.com on a Bob@X.com bounce", async () => {
    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-case", email: "Bob@X.com", hard: true },
    ]);

    expect(applied.suppressed).toBe(1);
    expect(await isSuppressed(env.DB, "bob@x.com")).toBe(true);
  });

  it("suppresses the matched delivery's address over the event's", async () => {
    await seedDelivery("carol@x.com", "msg-carol");

    await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-carol", email: "carol+alias@x.com" },
    ]);

    const rows = await env.DB.prepare("SELECT email FROM suppressions").all<{ email: string }>();
    expect(rows.results.map((r) => r.email)).toEqual(["carol@x.com"]);
  });
});
