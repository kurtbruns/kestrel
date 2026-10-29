import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IMPORT_OUTCOMES,
  type ImportCommitResponse,
  type ImportPlanResponse,
  type OutcomeCounts,
  type PlainListStatus,
} from "../shared/imports";
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

// Erasing a subscriber (SPEC §7): they are unsubscribed by it and their record is stripped to
// the address and when, past records still add up, and nothing brings them back but their
// own sign-up: not an import, not the publisher's hand.

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

/** A file in the format's first version, which says an erasure as a suppression. */
function csvFile(lines: string[]): { name: string; text: string } {
  return {
    name: "list.csv",
    text: `${["email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence", ...lines].join("\r\n")}\r\n`,
  };
}

/** A file in the format's second version, which says an erasure as why a row left. */
function csvFile2(lines: string[]): { name: string; text: string } {
  return {
    name: "list.csv",
    text: `${["email,status,opt_in,origin,unsubscribe_cause,suppression,unsubscribed_at,evidence,format", ...lines.map((l) => `${l},kestrel-subscribers/2`)].join("\r\n")}\r\n`,
  };
}

/** What an erasure leaves of a subscriber: the address, when, and that they left by it. */
const STRIPPED = {
  status: "unsubscribed",
  unsubscribe_cause: "erased",
  confirmed_at: null,
  confirm_sent_at: null,
  confirm_attempt_at: null,
  origin: null,
  opt_in: null,
  consent_evidence: null,
  import_id: null,
};

/** The same as stored, where both tokens are discarded too, so a link in mail already sent
 *  matches no one. */
const STRIPPED_ROW = { ...STRIPPED, confirm_token: null, unsub_token: null };

/** The subscriber row as stored, or null. */
function stored(email: string): Promise<subs.SubscriberRow | null> {
  return subs.getByEmail(env.DB, email);
}

/** Plan a file through the API, then commit that plan, attesting and acknowledging what it asks. */
async function planAndCommit(
  file: { name: string; text: string },
  plainListStatus?: PlainListStatus,
): Promise<{ plan: ImportPlanResponse; result: ImportCommitResponse }> {
  const extra = plainListStatus ? { plain_list_status: plainListStatus } : {};
  const plan: ImportPlanResponse = await readJson(
    await SELF.fetch(`${base}/api/imports/plan`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ file, ...extra }),
    }),
  );
  const res = await SELF.fetch(`${base}/api/imports`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      file,
      ...extra,
      plan_hash: plan.plan_hash,
      attestation: plan.attestation
        ? { version: plan.attestation.version, accepted: true }
        : undefined,
      acknowledge_sends: plan.sends_growing.map((s) => s.id),
    }),
  });
  expect(res.status).toBe(201);
  return { plan, result: await res.json() };
}

async function importCsv(lines: string[]): Promise<ImportCommitResponse> {
  return (await planAndCommit(csvFile(lines))).result;
}

/** Every outcome at zero, but those given. */
function counts(nonzero: Partial<OutcomeCounts>): OutcomeCounts {
  return { ...Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])), ...nonzero } as OutcomeCounts;
}

/** The tables any row naming `email` is in, whatever its casing. */
async function tablesNaming(email: string): Promise<string[]> {
  return (await everyRow())
    .filter((l) => l.toLowerCase().includes(email))
    .map((l) => l.split(":")[0] ?? "");
}

describe("erasing a subscriber (SPEC §7)", () => {
  it("unsubscribes them and strips their record to the address and when, the import's provenance and evidence included", async () => {
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
    const before = (await stored(email))!;

    const body = await eraseOk(email);

    expect(body.deliveries).toBe(2);
    expect(body.subscriber).toMatchObject({ id: before.id, email, ...STRIPPED, suppression: null });
    expect(body.subscriber.created_at).toBe(body.subscriber.unsubscribed_at);
    expect(before.unsub_token).not.toBeNull();
    expect(await tablesNaming(email)).toEqual(["subscribers"]);
    expect((await everyRow()).filter((l) => l.includes("203.0.113.7"))).toEqual([]);
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

  it("skips a pending recipient of a send in flight once they are erased (I2)", async () => {
    await seedConfirmed(["keep@example.com", "gone@example.com"]);
    const send = await frozenSend(Date.now() - 1000);
    await sends.resolveAudience(env.DB, send.id, Date.now());

    await eraseOk("gone@example.com");
    await sweep(env);

    expect((await sends.getSend(env.DB, send.id))!.recipient_count).toBe(2);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 1, skipped: 1 });
    expect(fakeOutbox().map((m) => m.to)).toEqual(["keep@example.com"]);
  });

  it("discards their tokens, so an unsubscribe link in mail sent before opens the invalid-link page and changes nothing", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    const oldToken = (await stored(email))!.unsub_token;
    await eraseOk(email);
    const before = await everyRow();

    const page = await SELF.fetch(`${base}/unsubscribe?token=${oldToken}`);
    expect(page.status).toBe(400);
    expect(await page.text()).toMatch(/This link is invalid/);
    const oneClick = await SELF.fetch(`${base}/unsubscribe?token=${oldToken}`, { method: "POST" });
    expect(oneClick.status).toBe(400);
    expect(await everyRow()).toEqual(before);
  });

  it("is not brought back by an import that lists the address as subscribed", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await eraseOk(email);

    const result = await importCsv([`${email},subscribed,double,sendy,,,,,,`]);

    expect(result.counts).toEqual(counts({ kept_unsubscribed: 1 }));
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
  });

  it("is brought back by the person's own subscribe and confirmation", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await eraseOk(email);

    expect(await readJson(await publicSubscribe(email))).toEqual({ status: "check_inbox" });
    expect(await confirmationsTo(email)).toBe(1);
    expect(await subs.audienceEmails(env.DB)).toEqual([]); // not until they confirm
    const token = (await stored(email))!.confirm_token!;
    await SELF.fetch(`${base}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });

    expect(await stored(email)).toMatchObject({
      status: "confirmed",
      unsubscribe_cause: null,
      origin: "kestrel",
      opt_in: "double",
    });
    expect(await subs.audienceEmails(env.DB)).toEqual([email]);
  });

  it("keeps a bounce the address already had, without the provider's words", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await subs.addSuppression(env.DB, email, "bounce", `550 <${email}> Permanent/General`);

    const body = await eraseOk(email);

    expect(body.subscriber).toMatchObject({
      ...STRIPPED,
      suppression: { reason: "bounce", detail: null },
    });
    expect(await suppressionOf(email)).toEqual({ email, reason: "bounce", detail: null });
  });

  it("erases someone who already left, and answers a repeat with the stripped subscriber, changing nothing", async () => {
    const email = "ada@example.com";
    await seedConfirmed(email);
    await subs.unsubscribeById(env.DB, "id-ada@example.com");
    expect((await stored(email))?.unsubscribe_cause).toBe("publisher");

    const first = await eraseOk(email);
    expect(first.subscriber).toMatchObject(STRIPPED);
    const before = await everyRow();

    const again = await eraseOk(email);
    expect(again).toEqual({ subscriber: first.subscriber, deliveries: 0 });
    expect(await everyRow()).toEqual(before);
  });

  it("answers 404 for an id it doesn't know", async () => {
    const res = await erase("no-such-id");
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toBe("not_found");
  });
});

describe("an import after an erasure (SPEC §7)", () => {
  const email = "ada@example.com";

  beforeEach(async () => {
    await seedConfirmed(email);
    await eraseOk(email);
  });

  for (const [what, file, status] of [
    [
      "an unsubscribed row",
      csvFile([
        `${email},unsubscribed,unknown,sendy,,,,2024-05-05T00:00:00Z,,"{""ip"":""203.0.113.7""}"`,
      ]),
      undefined,
    ],
    [
      "a plain list imported as unsubscribed",
      { name: "list.txt", text: `${email}\r\n` },
      "unsubscribed",
    ],
  ] as const) {
    it(`leaves them unsubscribed by the erasure for ${what}, recording nothing the file says about them`, async () => {
      const { plan, result } = await planAndCommit(file, status);

      const rows = [{ row: 1, email, outcome: "unchanged", suppression_added: false }];
      expect(plan.counts).toEqual(counts({ unchanged: 1 }));
      expect(plan.rows).toEqual(rows);
      expect(result.rows).toEqual(rows);
      expect(result.differed).toEqual([]);
      expect(await stored(email)).toMatchObject(STRIPPED_ROW);
      expect(await tablesNaming(email)).toEqual(["subscribers"]);
      expect((await everyRow()).filter((l) => l.includes("203.0.113.7"))).toEqual([]);
    });
  }

  it("still adds the file's own bounce beside the erasure", async () => {
    const { result } = await planAndCommit(
      csvFile([`${email},unsubscribed,unknown,sendy,bounce,,,,,`]),
    );

    expect(result.rows).toEqual([
      { row: 1, email, outcome: "suppressed", suppression_added: true },
    ]);
    expect((await suppressionOf(email))?.reason).toBe("import_bounce");
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
  });
});

describe("an import row whose person left by an erasure (SPEC §7)", () => {
  const email = "ada@example.com";
  const evidence = `"{""ip"":""203.0.113.7""}"`;

  for (const [version, file] of [
    [
      "kestrel-subscribers/2, as its cause",
      csvFile2([`${email},unsubscribed,double,sendy,erased,,2024-05-05T00:00:00Z,${evidence}`]),
    ],
    [
      "kestrel-subscribers/1, as a subscribed row's suppression",
      csvFile([`${email},subscribed,double,sendy,erased,2024-01-01T00:00:00Z,,,,${evidence}`]),
    ],
    [
      "kestrel-subscribers/1, as a pending row's suppression",
      csvFile([`${email},pending,double,sendy,erased,,,,,${evidence}`]),
    ],
  ] as const) {
    it(`records a new address with the address alone, written in ${version}`, async () => {
      const { plan, result } = await planAndCommit(file);

      const rows = [{ row: 1, email, outcome: "added_unsubscribed", suppression_added: false }];
      expect(plan.rows).toEqual(rows);
      expect(plan.suppressions_added).toBe(0);
      expect(plan.attestation).toBeNull();
      expect(result.rows).toEqual(rows);
      expect(await stored(email)).toMatchObject(STRIPPED_ROW);
      expect(await suppressionOf(email)).toBeNull();
      expect((await everyRow()).filter((l) => l.includes("203.0.113.7"))).toEqual([]);
    });
  }

  async function confirmByLink(): Promise<void> {
    const token = (await stored(email))!.confirm_token!;
    await SELF.fetch(`${base}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  }

  it("erases a subscriber an import confirmed, whom only their own sign-up brings back", async () => {
    await importCsv([`${email},subscribed,double,sendy,,,,,,${evidence}`]);
    const result = await importCsv([`${email},subscribed,double,sendy,erased,,,,,`]);
    expect(result.rows).toEqual([{ row: 1, email, outcome: "erased", suppression_added: false }]);
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
    expect(await subs.audienceEmails(env.DB)).toEqual([]);

    // Erasing them here changes nothing more.
    expect((await eraseOk(email)).deliveries).toBe(0);

    await publicSubscribe(email);
    expect(await confirmationsTo(email)).toBe(1);
    await confirmByLink();
    expect(await subs.audienceEmails(env.DB)).toEqual([email]);
  });

  it("erases a pending sign-up, whose confirmation link then no longer confirms", async () => {
    await publicSubscribe(email);
    const token = (await stored(email))!.confirm_token!;

    const { result } = await planAndCommit(
      csvFile2([`${email},unsubscribed,unknown,unknown,erased,,,`]),
    );

    expect(result.rows).toEqual([{ row: 1, email, outcome: "erased", suppression_added: false }]);
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
    const confirm = await SELF.fetch(`${base}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(confirm.status).toBe(400);
  });

  it("erases someone on the list as Erase does, past sends' records included, and names them apart in the plan", async () => {
    await seedConfirmed([email, "other@example.com"]);
    const sendId = await sentSend();
    await env.DB.prepare(
      "UPDATE deliveries SET event = 'bounced', bounce_kind = 'soft', event_detail = ? WHERE email = ?",
    )
      .bind("452 <Ada@Example.com> Mailbox Full", email)
      .run();
    const file = csvFile2([`${email},unsubscribed,unknown,unknown,erased,,,`]);

    const { plan, result } = await planAndCommit(file);

    const rows = [{ row: 1, email, outcome: "erased", suppression_added: false }];
    expect(plan.counts).toEqual(counts({ erased: 1 }));
    expect(plan.rows).toEqual(rows);
    expect(result.counts).toEqual(counts({ erased: 1 }));
    expect(result.rows).toEqual(rows);
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
    expect(await tablesNaming(email)).toEqual(["subscribers"]);
    const { results } = await env.DB.prepare(
      "SELECT email, event_detail FROM deliveries WHERE send_id = ? AND email <> 'other@example.com'",
    )
      .bind(sendId)
      .all<{ email: string; event_detail: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.email).toMatch(PLACEHOLDER);
    expect(results[0]!.event_detail).toBe(`452 <${results[0]!.email}> Mailbox Full`);
  });

  it("is refused for now, changing nothing, while a send run is handing that person to the provider", async () => {
    await seedConfirmed(email);
    const send = await frozenSend(Date.now() - 1000);
    await sends.resolveAudience(env.DB, send.id, Date.now());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sends SET status = 'sending', locked_until = ?, lease_token = 'run' WHERE id = ?",
      ).bind(Date.now() + 60_000, send.id),
      env.DB.prepare(
        "UPDATE deliveries SET status = 'dispatched', dispatch_key = 'k' WHERE send_id = ?",
      ).bind(send.id),
    ]);
    const file = csvFile2([`${email},unsubscribed,unknown,unknown,erased,,,`]);
    const plan: ImportPlanResponse = await readJson(
      await SELF.fetch(`${base}/api/imports/plan`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ file }),
      }),
    );
    const before = await everyRow();

    const res = await SELF.fetch(`${base}/api/imports`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ file, plan_hash: plan.plan_hash }),
    });

    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("run_in_progress");
    expect(await everyRow()).toEqual(before);
  });

  it("keeps a bounce already here beside it, without its words", async () => {
    await subs.addSuppression(env.DB, email, "bounce", `550 <${email}> no such user`);

    const { result } = await planAndCommit(
      csvFile2([`${email},unsubscribed,unknown,sendy,erased,,,`]),
    );

    expect(result.rows).toEqual([
      { row: 1, email, outcome: "added_unsubscribed", suppression_added: false },
    ]);
    expect(await suppressionOf(email)).toEqual({ email, reason: "bounce", detail: null });
    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
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

  it("a bounce by message id suppresses the address beside the erasure, writing its words nowhere", async () => {
    const email = "ada@example.com";
    const row = await erasedAfterSend(email);

    await applyDeliveryEvents(env.DB, [
      {
        type: "bounced",
        hard: true,
        detail: "smtp; 550 5.1.1 <Ada@Example.com> user unknown",
        providerId: row.provider_id,
        email,
      },
    ]);

    expect(await suppressionOf(email)).toEqual({ email, reason: "bounce", detail: null });
    expect(await suppressionOf(row.email)).toBeNull();
    const delivery = await env.DB.prepare(
      "SELECT event, event_detail FROM deliveries WHERE email = ?",
    )
      .bind(row.email)
      .first();
    expect(delivery).toEqual({ event: "bounced", event_detail: null });
    expect((await tablesNaming(email)).sort()).toEqual(["subscribers", "suppressions"]);
  });

  it("a complaint by message id records its outcome without words, and the erasure stands as why they left", async () => {
    const email = "ada@example.com";
    const row = await erasedAfterSend(email);

    await applyDeliveryEvents(env.DB, [
      {
        type: "complained",
        detail: "abuse report for ada@example.com",
        providerId: row.provider_id,
        email,
      },
    ]);

    expect(await stored(email)).toMatchObject(STRIPPED_ROW);
    expect(await suppressionOf(email)).toBeNull();
    const delivery = await env.DB.prepare(
      "SELECT event, event_detail FROM deliveries WHERE email = ?",
    )
      .bind(row.email)
      .first();
    expect(delivery).toEqual({ event: "complained", event_detail: null });
    expect(await tablesNaming(email)).toEqual(["subscribers"]);
  });

  it("suppresses nothing when the receipt carries no address", async () => {
    const email = "ada@example.com";
    const row = await erasedAfterSend(email);

    await applyDeliveryEvents(env.DB, [
      { type: "bounced", hard: true, providerId: row.provider_id, detail: "550 <ada@example.com>" },
    ]);

    expect((await env.DB.prepare("SELECT email FROM suppressions").all()).results).toEqual([]);
    expect(await tablesNaming(email)).toEqual(["subscribers"]);
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
    // It carries the subscriber as it still stands, since nothing was erased (docs/API.md,
    // principle 5).
    expect(await readJson(res)).toMatchObject({
      error: "run_in_progress",
      subscriber: { id: "id-ada@example.com", email, suppression: null },
    });
    expect(await everyRow()).toEqual(before);
  });

  it("goes ahead once the run has let go of its lease", async () => {
    const email = "ada@example.com";
    await inFlight(email, Date.now() - 1000);

    expect((await erase("id-ada@example.com")).status).toBe(200);
    expect(await tablesNaming(email)).toEqual(["subscribers"]);
  });
});
