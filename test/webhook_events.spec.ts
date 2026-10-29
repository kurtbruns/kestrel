import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELD_RECEIPT_TTL_MS } from "../src/db/sends";
import { audienceEmails, erase, getByEmail, isSuppressed } from "../src/db/subscribers";
import { clearFakeOutbox, FakeProvider } from "../src/providers/fake";
import type { DeliveryEvent } from "../src/providers/types";
import { sweep } from "../src/send/sweep";
import { applyDeliveryEvents, applyHeldReceipts } from "../src/services/webhook_events";
import {
  deliveryEvent,
  dueSend,
  resetDatabase,
  SEEDED_SEND_ID,
  seedConfirmed,
  seedDelivery,
} from "./support/fixtures";
import { logged } from "./support/log";

// applyDeliveryEvents() is the ONLY thing that mutates state from provider events, so the
// suppression rule (a deliverability rule apart from consent, SPEC §7, §10) and the
// complaint's unsubscribe (SPEC §7, Leaving) are unit-tested here. The SES adapter echoes
// the recipient address in every event, so an event keyed by `provider_id` alone can't come
// through parseWebhook; it's constructed directly to prove the service still recovers the
// address from the matched delivery row and acts on it.

/** The subscriber's status and why they left, or null when the address has none. */
async function standing(email: string): Promise<[string, string | null] | null> {
  const row = await getByEmail(env.DB, email);
  return row ? [row.status, row.unsubscribe_cause] : null;
}

async function deliveryBounceKind(providerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT bounce_kind FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ bounce_kind: string | null }>();
  return row?.bounce_kind ?? null;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("applyDeliveryEvents: suppression address recovery", () => {
  it("suppresses via the matched delivery row when a hard bounce carries only a provider id", async () => {
    await seedDelivery("idonly-hard@example.com", "msg-idonly-hard");
    const events: DeliveryEvent[] = [
      { type: "bounced", providerId: "msg-idonly-hard", hard: true },
    ];

    const applied = await applyDeliveryEvents(env.DB, events);

    expect(applied).toEqual({ applied: 1, suppressed: 1, unsubscribed: 0 });
    expect(await isSuppressed(env.DB, "idonly-hard@example.com")).toBe(true);
    expect(await deliveryEvent("msg-idonly-hard")).toBe("bounced");
    // The permanent/transient signal is frozen on the row for the record view (SPEC §8).
    expect(await deliveryBounceKind("msg-idonly-hard")).toBe("hard");
  });

  it("unsubscribes via the matched delivery row when a complaint carries only a provider id (SPEC §7)", async () => {
    await seedConfirmed("idonly-complaint@example.com");
    await seedDelivery("idonly-complaint@example.com", "msg-idonly-cmp");

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-idonly-cmp" },
    ]);

    expect(applied).toEqual({ applied: 1, suppressed: 0, unsubscribed: 1 });
    expect(await standing("idonly-complaint@example.com")).toEqual(["unsubscribed", "complaint"]);
    expect(await isSuppressed(env.DB, "idonly-complaint@example.com")).toBe(false);
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

  it("counts but neither records nor suppresses a provider-id-only event that matches no row", async () => {
    await seedDelivery("bystander@example.com", "msg-bystander");

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-unknown", hard: true },
    ]);

    // The event is counted, but there is no row to record it on and no address to suppress.
    expect(applied).toEqual({ applied: 1, suppressed: 0, unsubscribed: 0 });
    expect(await deliveryEvent("msg-bystander")).toBeNull();
    const { results: suppressions } = await env.DB.prepare("SELECT email FROM suppressions").all();
    expect(suppressions).toEqual([]);
    expect(await sendCounters()).toMatchObject({ c_bounced: 0 });
  });

  it("still suppresses from the event's own address when present (unchanged path)", async () => {
    // No delivery row: the address comes straight from the event, as before.
    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", email: "direct@example.com", hard: true },
    ]);

    expect(applied.suppressed).toBe(1);
    expect(await isSuppressed(env.DB, "direct@example.com")).toBe(true);
  });
});

async function sendCounters(): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    "SELECT c_accepted, c_delivered, c_bounced, c_complained FROM sends WHERE id = ?",
  )
    .bind(SEEDED_SEND_ID)
    .first<Record<string, number>>();
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
    await seedDelivery("resolved@example.com", null);
    const outcome = () =>
      env.DB.prepare("SELECT event FROM deliveries WHERE email = 'resolved@example.com'").first<{
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

  it("never lands an id-less receipt on a recipient the send loop has not settled, yet still acts on it", async () => {
    await seedDelivery("open@example.com", null);
    for (const status of ["pending", "dispatched"]) {
      await env.DB.prepare("UPDATE deliveries SET status = ? WHERE email = 'open@example.com'")
        .bind(status)
        .run();
      const before = await sendCounters();

      const applied = await applyDeliveryEvents(env.DB, [
        { type: "bounced", email: "open@example.com", hard: true },
      ]);

      const row = await env.DB.prepare(
        "SELECT status, event FROM deliveries WHERE email = 'open@example.com'",
      ).first<{ status: string; event: string | null }>();
      expect(row).toEqual({ status, event: null });
      expect(await sendCounters()).toEqual(before);
      expect(applied.suppressed).toBe(1); // from the event's own address (SPEC §10)
      expect(await isSuppressed(env.DB, "open@example.com")).toBe(true);
    }
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
    await seedConfirmed("bob@x.com");
    expect(await audienceEmails(env.DB)).toContain("bob@x.com");

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-case", email: "Bob@X.com", hard: true },
    ]);

    expect(applied.suppressed).toBe(1);
    expect(await isSuppressed(env.DB, "bob@x.com")).toBe(true);
    expect(await audienceEmails(env.DB)).not.toContain("bob@x.com");
  });

  it("suppresses the matched delivery's address over the event's", async () => {
    await seedDelivery("carol@x.com", "msg-carol");

    await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-carol", email: "carol+alias@x.com", hard: true },
    ]);

    const rows = await env.DB.prepare("SELECT email FROM suppressions").all<{ email: string }>();
    expect(rows.results.map((r) => r.email)).toEqual(["carol@x.com"]);
  });
});

describe("applyDeliveryEvents: what it logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one receipt.applied line per send, suppression.added only when it suppressed, and subscriber.complained for a complaint (SPEC §12)", async () => {
    await seedConfirmed("cmp@example.com");
    await seedDelivery("ok@example.com", "msg-log-ok");
    await seedDelivery("hard@example.com", "msg-log-hard");
    await seedDelivery("soft@example.com", "msg-log-soft");
    await seedDelivery("cmp@example.com", "msg-log-cmp");
    const printed = vi.spyOn(console, "log");

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-log-ok" },
      { type: "bounced", providerId: "msg-log-hard", hard: true },
      { type: "bounced", providerId: "msg-log-soft", hard: false },
      { type: "complained", providerId: "msg-log-cmp" },
      // Already complained: counted as unchanged rather than recorded again.
      { type: "delivered", providerId: "msg-log-cmp" },
      // A test send's receipt: no delivery row, so it lands under no send.
      { type: "delivered", providerId: "msg-test", email: "publisher@example.com" },
    ]);

    const lines = logged(printed);
    expect(lines.filter((l) => l.event === "receipt.applied")).toEqual([
      {
        event: "receipt.applied",
        level: "info",
        sendId: SEEDED_SEND_ID,
        matched: true,
        delivered: 2,
        bounced: 2,
        complained: 1,
        recorded: 4,
        unchanged: 1,
        held: 0,
      },
      {
        event: "receipt.applied",
        level: "info",
        matched: false,
        delivered: 1,
        bounced: 0,
        complained: 0,
        recorded: 0,
        unchanged: 1,
        held: 0,
      },
    ]);
    // The soft bounce is not a suppression, the complaint unsubscribed rather than
    // suppressed, and the unmatched send acted on no one.
    expect(lines.filter((l) => l.event === "suppression.added")).toEqual([
      {
        event: "suppression.added",
        level: "info",
        sendId: SEEDED_SEND_ID,
        matched: true,
        source: "webhook",
        count: 1,
      },
    ]);
    expect(lines.filter((l) => l.event === "subscriber.complained")).toEqual([
      {
        event: "subscriber.complained",
        level: "info",
        sendId: SEEDED_SEND_ID,
        matched: true,
        count: 1,
        unsubscribed: 1,
        no_subscriber: 0,
      },
    ]);
    // Counts only: no address reaches the log.
    expect(JSON.stringify(lines)).not.toContain("@example.com");
  });
});

describe("a complaint is leaving (SPEC §7, Leaving)", () => {
  const DAY = 86_400_000;

  /** Move the seeded send's fire time back, so a confirmation can come after it. */
  async function sendFiredAt(at: number): Promise<void> {
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(at, SEEDED_SEND_ID)
      .run();
  }

  it("unsubscribes the reader by a complaint, immediately and adding no suppression", async () => {
    await seedConfirmed("spam@example.com");
    await seedDelivery("spam@example.com", "msg-spam");

    await applyDeliveryEvents(env.DB, [{ type: "complained", providerId: "msg-spam" }]);

    expect(await standing("spam@example.com")).toEqual(["unsubscribed", "complaint"]);
    expect(await audienceEmails(env.DB)).toEqual([]);
    expect(await isSuppressed(env.DB, "spam@example.com")).toBe(false);
  });

  it("unsubscribes a reader whatever post the complaint is about, one sent before they last confirmed included", async () => {
    // A reader who confirmed again after the post, here or by an import, still leaves by it.
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO imports (id, created_at, principal_kind, file_name, file_sha256, plan_hash, counts)
       VALUES ('imp-1', ?, 'service', 'list.csv', 'sha', 'plan', '{}')`,
    )
      .bind(now)
      .run();
    await seedConfirmed(["again@example.com", "imported@example.com"]);
    await env.DB.prepare(
      "UPDATE subscribers SET import_id = 'imp-1' WHERE email = 'imported@example.com'",
    ).run();
    await seedDelivery("again@example.com", "msg-old");
    await seedDelivery("imported@example.com", "msg-older");
    await sendFiredAt(now - DAY);

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-old" },
      { type: "complained", providerId: "msg-older" },
    ]);

    expect(applied.unsubscribed).toBe(2);
    expect(await standing("again@example.com")).toEqual(["unsubscribed", "complaint"]);
    expect(await standing("imported@example.com")).toEqual(["unsubscribed", "complaint"]);
    expect(await deliveryEvent("msg-old")).toBe("complained");
  });

  it("applies a complaint that ties to no post, such as one about a confirmation email", async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('p1', 'pending@example.com', 'pending', 'u-p1', ?)",
    )
      .bind(Date.now())
      .run();

    await applyDeliveryEvents(env.DB, [
      { type: "complained", providerId: "msg-confirmation", email: "pending@example.com" },
    ]);

    expect(await standing("pending@example.com")).toEqual(["unsubscribed", "complaint"]);
  });

  it("changes no one for a complaint that reaches no subscriber", async () => {
    const applied = await applyDeliveryEvents(env.DB, [
      { type: "complained", email: "stranger@example.com" },
    ]);

    expect(applied).toEqual({ applied: 1, suppressed: 0, unsubscribed: 0 });
    expect(await standing("stranger@example.com")).toBeNull();
    expect(await isSuppressed(env.DB, "stranger@example.com")).toBe(false);
  });

  it("keeps the stronger reason for someone who already left: a complaint over their own unsubscribe, an erasure over a complaint", async () => {
    await seedConfirmed(["left@example.com", "gone@example.com"]);
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = 1, unsubscribe_cause = CASE email WHEN 'left@example.com' THEN 'reader' ELSE 'erased' END",
    ).run();

    await applyDeliveryEvents(env.DB, [
      { type: "complained", email: "left@example.com" },
      { type: "complained", email: "gone@example.com" },
    ]);

    expect(await standing("left@example.com")).toEqual(["unsubscribed", "complaint"]);
    expect(await standing("gone@example.com")).toEqual(["unsubscribed", "erased"]);
    // When they left stays when they first left.
    expect((await getByEmail(env.DB, "left@example.com"))?.unsubscribed_at).toBe(1);
  });
});

// The provider can report a message before the send loop has recorded its answer, which is
// what carries the message's id (SPEC §10).
describe("applyDeliveryEvents: a receipt that beats the provider's answer to its row", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearFakeOutbox();
  });

  /** A recipient handed to the provider and awaiting its answer: in flight, with no id. */
  async function inFlight(email: string): Promise<void> {
    await seedDelivery(email, null);
    await env.DB.prepare("UPDATE deliveries SET status = 'dispatched' WHERE email = ?")
      .bind(email)
      .run();
  }

  async function heldCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM held_receipts").first<{
      n: number;
    }>();
    return row!.n;
  }

  it("records a bounce SES reports while the batch is still being answered on its delivery row (SPEC §10)", async () => {
    await seedConfirmed("early@example.com");
    const send = await dueSend();
    // The bounce arrives after the provider took the message and before the send loop
    // records the answer that carries its id.
    const real = FakeProvider.prototype.sendBatch;
    vi.spyOn(FakeProvider.prototype, "sendBatch").mockImplementation(async function (
      this: FakeProvider,
      rendered,
      recipients,
      opts,
    ) {
      const answer = await real.call(this, rendered, recipients, opts);
      if (answer.kind === "answered") {
        for (const r of answer.results) {
          if (r.accepted) {
            await applyDeliveryEvents(env.DB, [
              { type: "bounced", providerId: r.providerId, email: r.email, hard: true },
            ]);
          }
        }
      }
      return answer;
    });

    await sweep(env);

    const row = await env.DB.prepare(
      "SELECT status, event, bounce_kind FROM deliveries WHERE send_id = ? AND email = 'early@example.com'",
    )
      .bind(send.id)
      .first<{ status: string; event: string | null; bounce_kind: string | null }>();
    expect(row).toEqual({ status: "accepted", event: "bounced", bounce_kind: "hard" });
    const counts = await env.DB.prepare("SELECT c_accepted, c_bounced FROM sends WHERE id = ?")
      .bind(send.id)
      .first<{ c_accepted: number; c_bounced: number }>();
    expect(counts).toEqual({ c_accepted: 0, c_bounced: 1 });
    expect(await isSuppressed(env.DB, "early@example.com")).toBe(true);
    expect(await heldCount()).toBe(0);
  });

  it("holds the receipt rather than land it on an older send's row resolved as sent", async () => {
    await seedDelivery("both@example.com", null); // an earlier send, resolved as sent
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s-later', 'p-receipts', 'sending', ?, '', '', '', ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('s-later', 'both@example.com', 'dispatched', ?)",
      ).bind(now + 1),
    ]);

    const applied = await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-new", email: "both@example.com", hard: true },
    ]);

    const { results } = await env.DB.prepare(
      "SELECT status, event FROM deliveries WHERE email = 'both@example.com' ORDER BY id",
    ).all<{ status: string; event: string | null }>();
    expect(results).toEqual([
      { status: "accepted", event: null },
      { status: "dispatched", event: null },
    ]);
    expect(await heldCount()).toBe(1);
    expect(applied.suppressed).toBe(1); // the list acts at once
  });

  it("lands a held receipt on its recipient once the publisher resolves it as sent (SPEC §12)", async () => {
    await inFlight("resolved@example.com");
    await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-lost", email: "resolved@example.com", hard: false },
    ]);
    expect(await applyHeldReceipts(env.DB, Date.now(), 10)).toEqual({
      recorded: 0,
      unchanged: 0,
      expired: 0,
      waiting: 1,
    });

    // Resolve's "assume sent": accepted, with no id the provider never answered with.
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'accepted' WHERE email = 'resolved@example.com'",
    ).run();
    const result = await applyHeldReceipts(env.DB, Date.now(), 10);

    expect(result).toEqual({ recorded: 1, unchanged: 0, expired: 0, waiting: 0 });
    const row = await env.DB.prepare(
      "SELECT event, bounce_kind FROM deliveries WHERE email = 'resolved@example.com'",
    ).first<{ event: string | null; bounce_kind: string | null }>();
    expect(row).toEqual({ event: "bounced", bounce_kind: "soft" });
    expect(await heldCount()).toBe(0);
  });

  it("releases a held receipt with no row to land on once its recipient is resolved as not sent", async () => {
    await inFlight("unsent@example.com");
    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-unsent", email: "unsent@example.com" },
    ]);
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'unsent' WHERE email = 'unsent@example.com'",
    ).run();

    const result = await applyHeldReceipts(env.DB, Date.now(), 10);

    expect(result).toEqual({ recorded: 0, unchanged: 1, expired: 0, waiting: 0 });
    const row = await env.DB.prepare(
      "SELECT status, event FROM deliveries WHERE email = 'unsent@example.com'",
    ).first<{ status: string; event: string | null }>();
    expect(row).toEqual({ status: "unsent", event: null });
    expect(await heldCount()).toBe(0);
  });

  it("discards a held receipt still waiting after a day", async () => {
    await inFlight("waiting@example.com");
    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-wait", email: "waiting@example.com" },
    ]);

    expect(
      (await applyHeldReceipts(env.DB, Date.now() + HELD_RECEIPT_TTL_MS - 60_000, 10)).waiting,
    ).toBe(1);
    const result = await applyHeldReceipts(env.DB, Date.now() + HELD_RECEIPT_TTL_MS, 10);

    expect(result).toEqual({ recorded: 0, unchanged: 0, expired: 1, waiting: 0 });
    expect(await heldCount()).toBe(0);
  });

  it("holds nothing for a test send's or a confirmation's receipt, whose address has nothing in flight", async () => {
    await seedDelivery("reader@example.com", "msg-past");

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: "msg-test", email: "reader@example.com" },
    ]);

    expect(await heldCount()).toBe(0);
    expect(await deliveryEvent("msg-past")).toBeNull();
  });

  it("discards a receipt held for an address when its subscriber is erased (SPEC §7)", async () => {
    await seedConfirmed("forget@example.com");
    await inFlight("forget@example.com");
    await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-forget", email: "forget@example.com", hard: false },
    ]);
    expect(await heldCount()).toBe(1);

    const outcome = await erase(env.DB, "id-forget@example.com");

    expect(outcome.kind).toBe("erased");
    expect(await heldCount()).toBe(0);
  });
});
