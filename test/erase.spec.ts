import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportCommitResponse, ImportPlanResponse } from "../shared/imports";
import type { SendView } from "../shared/sends";
import type { EraseResponse } from "../shared/subscribers";
import { createRouter } from "../src/app";
import * as sends from "../src/db/sends";
import * as subs from "../src/db/subscribers";
import { type AppEnv, getConfig } from "../src/env";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

// Erasing a subscriber (SPEC §7): their data goes, past records still add up, and only a
// do-not-contact marker is kept, which an import never lifts and the person's own
// confirmation does.

const PLACEHOLDER = /^erased:[0-9a-f]{16}$/;

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

function erase(id: string): Promise<Response> {
  return SELF.fetch(`${base}/api/subscribers/${id}/erase`, { method: "POST", headers: AUTH });
}

async function eraseOk(email: string): Promise<EraseResponse> {
  const row = await subs.getByEmail(env.DB, email);
  const res = await erase(row!.id);
  expect(res.status).toBe(200);
  return res.json();
}

function adminAdd(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${base}/api/subscribers`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(body),
  });
}

/** The public form, through the real router, waiting for the work it does after answering. */
async function publicSubscribe(email: string): Promise<Response> {
  const ctx = createExecutionContext();
  const e = env as AppEnv;
  const res = await createRouter(getConfig(e)).handle(
    new Request(`${base}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function confirmationsTo(email: string): Promise<number> {
  const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
  return outbox.messages.filter(
    (m: any) => m.to === email && m.subject === "Confirm your subscription",
  ).length;
}

async function suppressionOf(email: string) {
  return env.DB.prepare("SELECT email, reason, detail FROM suppressions WHERE email = ?")
    .bind(email)
    .first<{ email: string; reason: string; detail: string | null }>();
}

/** A send that went out to everyone confirmed now, through the real send loop. */
async function sentSend(): Promise<string> {
  const send = await frozenSend(Date.now() - 1000);
  await sweep(env);
  expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
  return send.id;
}

/** Every row of every table the app keeps, as `table: row` lines, for a search by content. */
async function everyRow(): Promise<string[]> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  const lines: string[] = [];
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${name}`).all();
    for (const row of results) {
      lines.push(`${name}: ${JSON.stringify(row)}`);
    }
  }
  return lines;
}

async function importCsv(lines: string[]): Promise<ImportCommitResponse> {
  const file = {
    name: "list.csv",
    text: `${["email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence", ...lines].join("\r\n")}\r\n`,
  };
  const plan: ImportPlanResponse = await readJson(
    await SELF.fetch(`${base}/api/imports/plan`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ file }),
    }),
  );
  const res = await SELF.fetch(`${base}/api/imports`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      file,
      plan_hash: plan.plan_hash,
      attestation: plan.attestation
        ? { version: plan.attestation.version, accepted: true }
        : undefined,
      acknowledge_sends: plan.sends_growing.map((s) => s.id),
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("erasing a subscriber (SPEC §7)", () => {
  it("leaves the address in no table but its one suppression, the import's provenance and evidence included", async () => {
    const email = "ada@example.com";
    await importCsv([
      `${email},subscribed,double,sendy,,2024-01-01T00:00:00Z,2024-01-02T00:00:00Z,,,"{""ip"":""203.0.113.7""}"`,
    ]);
    await seedConfirmed("other@example.com");
    await sentSend();
    const second = await sentSend();
    // A provider's words that name the address, in its own casing. (The local stand-in's
    // message ids name it too.)
    await env.DB.prepare(
      "UPDATE deliveries SET event = 'bounced', bounce_kind = 'soft', event_detail = ? WHERE send_id = ? AND email = ?",
    )
      .bind("SMTP; 452 <Ada@Example.com> Mailbox Full", second, email)
      .run();
    expect((await everyRow()).some((l) => l.toLowerCase().includes(email))).toBe(true);

    const body = await eraseOk(email);

    expect(body).toEqual({ erased: { email, deliveries: 2, suppression: "erased" } });
    expect((await everyRow()).filter((l) => l.toLowerCase().includes(email))).toEqual([
      `suppressions: ${JSON.stringify({ email, reason: "erased", detail: null, created_at: (await subs.suppressionOf(env.DB, email))!.created_at })}`,
    ]);
    // One placeholder for the person, the same on every send.
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT email, event_detail FROM deliveries WHERE email <> 'other@example.com' ORDER BY event_detail",
    ).all<{ email: string; event_detail: string | null }>();
    expect(results.map((r) => r.email)).toHaveLength(2);
    expect(new Set(results.map((r) => r.email)).size).toBe(1);
    expect(results[0]!.email).toMatch(PLACEHOLDER);
    expect(results.map((r) => r.event_detail)).toEqual([
      null,
      `SMTP; 452 <${results[0]!.email}> Mailbox Full`,
    ]);
  });

  it("keeps every past record summing to its audience", async () => {
    await seedConfirmed(["a@example.com", "b@example.com", "c@example.com"]);
    const id = await sentSend();
    const before: SendView = (
      await readJson(await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH }))
    ).send;

    await eraseOk("b@example.com");

    const after: SendView = (
      await readJson(await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH }))
    ).send;
    expect(after.audience).toEqual({ ...before.audience, count: 3 });
    expect(after.counts).toEqual(before.counts);
    expect(await sends.deliveryRollup(env.DB, id)).toEqual({ accepted: 3 });
    const rows = await readJson(
      await SELF.fetch(`${base}/api/sends/${id}/deliveries?view=all`, { headers: AUTH }),
    );
    expect(rows.page.total).toBe(3);
    const emails: string[] = rows.deliveries.map((d: { email: string }) => d.email);
    expect(emails.filter((e) => e !== "a@example.com" && e !== "c@example.com")).toEqual([
      expect.stringMatching(PLACEHOLDER),
    ]);
  });

  it("skips a pending recipient of a send in flight once they are erased (I1)", async () => {
    await seedConfirmed(["keep@example.com", "gone@example.com"]);
    const send = await frozenSend(Date.now() - 1000);
    await sends.resolveAudience(env.DB, send.id, Date.now());

    await eraseOk("gone@example.com");
    await sweep(env);

    expect((await sends.getSend(env.DB, send.id))!.recipient_count).toBe(2);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 1, skipped: 1 });
    expect(fakeOutbox().map((m) => m.to)).toEqual(["keep@example.com"]);
  });

  it("is not brought back by an import that lists the address as subscribed", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await eraseOk(email);

    const result = await importCsv([`${email},subscribed,double,sendy,,,,,,`]);

    expect(result.counts.blocked_by_suppression).toBe(1);
    expect(result.counts.create_confirmed).toBe(0);
    expect(await subs.getByEmail(env.DB, email)).toBeNull();
    expect((await suppressionOf(email))?.reason).toBe("erased");
  });

  it("is brought back by the person's own subscribe and confirmation, which lifts the marker", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await eraseOk(email);

    expect(await readJson(await publicSubscribe(email))).toEqual({ status: "check_inbox" });
    expect(await confirmationsTo(email)).toBe(1);
    expect((await suppressionOf(email))?.reason).toBe("erased"); // not until they confirm
    const token = (await subs.getByEmail(env.DB, email))!.confirm_token!;
    await SELF.fetch(`${base}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });

    expect(await suppressionOf(email)).toBeNull();
    expect(await subs.audienceEmails(env.DB)).toEqual([email]);
  });

  it("keeps a bounce the address already had", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await subs.addSuppression(env.DB, email, "bounce", "Permanent/General");

    const body = await eraseOk(email);

    expect(body.erased.suppression).toBe("bounce");
    expect(await suppressionOf(email)).toEqual({
      email,
      reason: "bounce",
      detail: "Permanent/General",
    });
    expect(await subs.getByEmail(env.DB, email)).toBeNull();
  });

  it("answers 404 for an id it doesn't know, an erased one included", async () => {
    await seedConfirmed("ada@example.com");
    expect((await erase("id-ada@example.com")).status).toBe(200);
    const again = await erase("id-ada@example.com");
    expect(again.status).toBe(404);
    expect((await readJson(again)).error).toBe("not_found");
  });
});

describe("a receipt that lands after an erasure (SPEC §7)", () => {
  /** A sent send to `email`, then its erasure; the delivery row's placeholder and message id. */
  async function erasedAfterSend(email: string) {
    await seedConfirmed(email);
    const sendId = await sentSend();
    await eraseOk(email);
    const row = await env.DB.prepare("SELECT email, provider_id FROM deliveries WHERE send_id = ?")
      .bind(sendId)
      .first<{ email: string; provider_id: string }>();
    // The message id keeps its own form, with only the address in it replaced.
    expect(row!.provider_id).toBe(`fake-${sendId}:${row!.email}`);
    return row!;
  }

  for (const [event, reason] of [
    [
      { type: "bounced", hard: true, detail: "smtp; 550 5.1.1 <Ada@Example.com> user unknown" },
      "bounce",
    ],
    [{ type: "complained", detail: "abuse report for ada@example.com" }, "complaint"],
  ] as const) {
    it(`a ${reason} by message id replaces the marker and writes the address nowhere else`, async () => {
      const email = "ada@example.com";
      const row = await erasedAfterSend(email);

      await applyDeliveryEvents(env.DB, [{ ...event, providerId: row.provider_id, email }]);

      expect((await suppressionOf(email))?.reason).toBe(reason);
      expect(await suppressionOf(row.email)).toBeNull();
      const delivery = await env.DB.prepare(
        "SELECT event, event_detail FROM deliveries WHERE email = ?",
      )
        .bind(row.email)
        .first();
      expect(delivery).toEqual({ event: event.type, event_detail: null });
      expect(
        (await everyRow())
          .filter((l) => l.toLowerCase().includes(email))
          .map((l) => l.split(":")[0]),
      ).toEqual(["suppressions"]);
    });
  }

  it("suppresses nothing new when the receipt carries no address, leaving the marker", async () => {
    const email = "ada@example.com";
    const row = await erasedAfterSend(email);

    await applyDeliveryEvents(env.DB, [
      { type: "bounced", hard: true, providerId: row.provider_id, detail: "550 <ada@example.com>" },
    ]);

    expect((await env.DB.prepare("SELECT email, reason FROM suppressions").all()).results).toEqual([
      { email, reason: "erased" },
    ]);
    expect((await everyRow()).filter((l) => l.includes(email))).toHaveLength(1);
  });
});

describe("erasing someone a send run is handing off (SPEC §7)", () => {
  /** A send whose run holds its lease until `until`, with `email`'s row handed off. */
  async function inFlight(email: string, until: number): Promise<string> {
    await seedConfirmed(email);
    const send = await frozenSend(Date.now() - 1000);
    await sends.resolveAudience(env.DB, send.id, Date.now());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sends SET status = 'sending', locked_until = ?, lease_token = 'run' WHERE id = ?",
      ).bind(until, send.id),
      env.DB.prepare(
        "UPDATE deliveries SET status = 'dispatched', dispatch_key = 'k' WHERE send_id = ?",
      ).bind(send.id),
    ]);
    return send.id;
  }

  it("is refused for now, changing nothing, while the run holds its lease", async () => {
    const email = "ada@example.com";
    await inFlight(email, Date.now() + 60_000);
    const before = await everyRow();

    const res = await erase("id-ada@example.com");

    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("run_in_progress");
    expect(await everyRow()).toEqual(before);
  });

  it("goes ahead once the run has let go of its lease", async () => {
    const email = "ada@example.com";
    await inFlight(email, Date.now() - 1000);

    expect((await erase("id-ada@example.com")).status).toBe(200);
    expect((await everyRow()).filter((l) => l.includes(email))).toHaveLength(1);
  });
});

describe("adding an erased address by hand (SPEC §7)", () => {
  it("asks the publisher first, and sends the confirmation once they acknowledge it", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await eraseOk(email);
    const erasedAt = (await subs.suppressionOf(env.DB, email))!.created_at;

    const refused = await adminAdd({ email });
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      error: "erasure_acknowledgement_required",
      erased_at: erasedAt,
    });
    expect(await confirmationsTo(email)).toBe(0);
    expect(await subs.getByEmail(env.DB, email)).toBeNull();

    const sent = await adminAdd({ email, acknowledge_erasure: true });
    expect(sent.status).toBe(201);
    expect(await readJson(sent)).toMatchObject({ action: "created" });
    expect(await confirmationsTo(email)).toBe(1);
    expect((await suppressionOf(email))?.reason).toBe("erased");
  });

  it("doesn't ask about an address that wasn't erased, or one whose bounce stands", async () => {
    expect((await adminAdd({ email: "new@example.com" })).status).toBe(201);
    await subs.addSuppression(env.DB, "bounced@example.com", "bounce");
    expect(await readJson(await adminAdd({ email: "bounced@example.com" }))).toMatchObject({
      action: "suppressed",
    });
  });

  it("refuses an acknowledgement that isn't true or false, naming the field", async () => {
    const res = await adminAdd({ email: "new@example.com", acknowledge_erasure: "yes" });
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("acknowledge_erasure");
  });
});
