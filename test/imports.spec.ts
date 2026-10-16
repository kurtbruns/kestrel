import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import referencePage from "../docs/publishing/01-your-list.md?raw";
import {
  EXPORT_PAGE_ROWS,
  type ExportResponse,
  IMPORT_COLUMNS,
  IMPORT_FORMAT,
  IMPORT_LIMITS,
  IMPORT_OUTCOMES,
  type ImportCommitResponse,
  type ImportPlanResponse,
  type OutcomeCounts,
  toImportCsv,
} from "../shared/imports";
import * as importsDb from "../src/db/imports";
import { updateSettings } from "../src/db/settings";
import * as subscribers from "../src/db/subscribers";
import { getConfig } from "../src/env";
import { clearFakeNotifications, fakeNotifications } from "../src/notify/fake";
import { notifyPublisher } from "../src/notify/notify";
import type { Principal } from "../src/router";
import { Budget } from "../src/send/budget";
import { commitImport, maxImportRows, planImport } from "../src/services/imports";
import { guardD1 } from "./support/d1_guard";
import { addresses, frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, adminAuth, base, JSON_AUTH, readJson } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { fetchWith } from "./support/worker_env";

// Bringing a list in and taking it out (SPEC §7, §8): one format, a plan that writes nothing,
// a commit that applies the plan whole under the publisher's attestation, and an export that
// another instance imports back.

const HEADER =
  "email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence";
const HUMAN: Principal = { kind: "human", email: "Publisher@Example.com", via: "dev" };
const ATTEST = { version: 1, accepted: true };
const PAID = { SUBREQUEST_BUDGET: "1000" };

function csvFile(lines: string[], name = "list.csv") {
  return { name, text: `${[HEADER, ...lines].join("\r\n")}\r\n` };
}

function plan(body: unknown, headers: Record<string, string> = JSON_AUTH): Promise<Response> {
  return SELF.fetch(`${base}/api/imports/plan`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function commit(body: unknown, headers: Record<string, string> = JSON_AUTH): Promise<Response> {
  return SELF.fetch(`${base}/api/imports`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function planOk(body: unknown): Promise<ImportPlanResponse> {
  const res = await plan(body);
  expect(res.status).toBe(200);
  return res.json();
}

/** Plan a file and commit that plan as a person, attesting and acknowledging what it asks. */
async function importFile(
  file: { name: string; text: string },
  extra: Record<string, unknown> = {},
): Promise<ImportCommitResponse> {
  const p = await planOk({ file, ...extra });
  const res = await commit({
    file,
    ...extra,
    plan_hash: p.plan_hash,
    attestation: p.attestation ? ATTEST : undefined,
    acknowledge_sends: p.sends_growing.map((s) => s.id),
  });
  expect(res.status).toBe(201);
  return res.json();
}

function counts(over: Partial<OutcomeCounts>): OutcomeCounts {
  return { ...(Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts), ...over };
}

async function subscriberRow(email: string) {
  return env.DB.prepare(
    "SELECT status, origin, opt_in, consent_evidence, import_id, confirm_token, confirmed_at, unsubscribed_at FROM subscribers WHERE email = ?",
  )
    .bind(email)
    .first<Record<string, unknown>>();
}

async function suppressionOf(email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT reason FROM suppressions WHERE email = ?")
    .bind(email)
    .first<{ reason: string }>();
  return row?.reason ?? null;
}

async function seedPending(email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, confirm_sent_at, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, Date.now(), `uns-${email}`, Date.now())
    .run();
}

async function seedUnsubscribed(email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribed_at) VALUES (?, ?, 'unsubscribed', ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `uns-${email}`, Date.now(), Date.now())
    .run();
}

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

const planOptions = {
  maxRows: IMPORT_LIMITS.maxRows,
  maxRowsReason: null,
  publication: "Field Notes",
};

beforeEach(async () => {
  await resetDatabase();
  clearFakeNotifications();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the format, as the API serves it (SPEC §7)", () => {
  it("describes the columns the importer reads, prefers the full CSV, and says what a plain list loses", async () => {
    const res = await SELF.fetch(`${base}/api/imports/format`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.format).toBe(IMPORT_FORMAT);
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(
      IMPORT_COLUMNS.map((c) => c.name),
    );
    expect(body.preferred.kind).toBe("csv");
    expect(body.files.find((f: { kind: string }) => f.kind === "txt").loses.length).toBeGreaterThan(
      0,
    );
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual([...IMPORT_OUTCOMES]);
  });

  it("names the lower row limit on Workers Free, and the full one when the budget says Paid", async () => {
    const free = await readJson(await SELF.fetch(`${base}/api/imports/format`, { headers: AUTH }));
    expect(free.limits.max_rows).toBe(IMPORT_LIMITS.maxRowsFree);
    // Said to the publisher, who may not run the deployment: no setting's name in it.
    expect(free.limits.max_rows_reason).toBe(
      "That’s the limit on Cloudflare’s Workers Free plan. Whoever runs your Kestrel can raise it to 10,000 rows by moving to Workers Paid.",
    );
    const paid = await readJson(await fetchWith(PAID, "/api/imports/format", { headers: AUTH }));
    expect(paid.limits).toMatchObject({ max_rows: IMPORT_LIMITS.maxRows, max_rows_reason: null });
  });

  it("serves templates that, uploaded unchanged, plan cleanly", async () => {
    const csv = await SELF.fetch(`${base}/api/imports/template.csv`, { headers: AUTH });
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    // Named as examples of an import, so a downloaded one isn't taken for an exported list.
    expect(csv.headers.get("content-disposition")).toBe(
      'attachment; filename="kestrel-import-example.csv"',
    );
    const fromCsv = await planOk({
      file: { name: "kestrel-import-example.csv", text: await csv.text() },
    });
    expect(fromCsv.counts).toEqual(
      counts({ create_confirmed: 2, create_unsubscribed: 1, suppression_added: 1 }),
    );
    const txt = await SELF.fetch(`${base}/api/imports/template.txt`, { headers: AUTH });
    expect(txt.headers.get("content-disposition")).toBe(
      'attachment; filename="kestrel-import-example.txt"',
    );
    const fromTxt = await planOk({
      file: { name: "kestrel-import-example.txt", text: await txt.text() },
    });
    expect(fromTxt.counts).toEqual(counts({ create_confirmed: 3 }));
  });

  it("is documented on the reference page column by column and outcome by outcome, with an example that plans cleanly", async () => {
    const tableRows = (heading: string) => {
      const table = referencePage.split(heading)[1]?.split("\n\n")[0] ?? "";
      return table
        .split("\n")
        .filter((l) => l.startsWith("| `"))
        .map((l) => l.split("|").map((cell) => cell.trim()));
    };
    const columns = tableRows("| Column | Required | Values | Meaning |");
    expect(columns.map((c) => c[1])).toEqual(IMPORT_COLUMNS.map((c) => `\`${c.name}\``));
    expect(columns.map((c) => c[2])).toEqual(
      IMPORT_COLUMNS.map((c) => (c.required ? "yes" : "no")),
    );
    for (const [i, col] of IMPORT_COLUMNS.entries()) {
      for (const value of col.values ?? []) {
        expect(columns[i]?.[3]).toContain(`\`${value}\``);
      }
    }
    const outcomes = tableRows("| Outcome | When |");
    expect(outcomes.map((o) => o[1])).toEqual(IMPORT_OUTCOMES.map((o) => `\`${o}\``));
    const example =
      referencePage
        .split("only the columns they use, since an optional column may be left out:\n\n```\n")[1]
        ?.split("```")[0] ?? "";
    const p = await planOk({ file: { name: "example.csv", text: example } });
    expect(p.counts).toEqual(
      counts({ create_confirmed: 2, create_unsubscribed: 1, suppression_added: 1 }),
    );
    // The short sample the page shows first, in its convert step, plans cleanly too.
    const sample =
      referencePage
        .split("the five columns that decide what happens to each row:\n\n```\n")[1]
        ?.split("```")[0] ?? "";
    const q = await planOk({ file: { name: "sample.csv", text: sample } });
    expect(q.counts).toEqual(counts({ create_confirmed: 2, create_unsubscribed: 1 }));
  });

  it("is the publisher's: every import route is behind sign-in", async () => {
    for (const path of [
      "/api/imports/format",
      "/api/imports/template.csv",
      "/api/subscribers/export",
    ]) {
      expect((await SELF.fetch(`${base}${path}`)).status).toBe(401);
    }
    expect((await plan({ file: csvFile([]) }, { "content-type": "application/json" })).status).toBe(
      401,
    );
  });
});

describe("refusals name what was wrong and what was expected (SPEC §7)", () => {
  it("unrecognized_format: a file that isn't the format, or isn't a plain list", async () => {
    const xlsx = await plan({ file: { name: "list.xlsx", text: "x" } });
    expect(xlsx.status).toBe(400);
    expect(await readJson(xlsx)).toMatchObject({ error: "unrecognized_format", field: "file" });
    const table = await plan({ file: { name: "list.txt", text: "a@x.io,subscribed\n" } });
    expect(await readJson(table)).toMatchObject({ error: "unrecognized_format", row: 1 });
  });

  it("invalid_field: an extra column, by name, and a value outside its set, with the values", async () => {
    const extra = await readJson(
      await plan({
        file: {
          name: "l.csv",
          text: "email,status,opt_in,origin,name\na@x.io,subscribed,double,sendy,Ada\n",
        },
      }),
    );
    expect(extra).toMatchObject({ error: "invalid_field", column: "name", row: 0 });
    const value = await readJson(
      await plan({ file: csvFile(["a@x.io,active,double,sendy,,,,,,"]) }),
    );
    expect(value).toMatchObject({
      error: "invalid_field",
      row: 1,
      column: "status",
      allowed: ["subscribed", "pending", "unsubscribed", "none"],
    });
  });

  it("too_many_rows: over this deployment's limit, naming it", async () => {
    const lines = Array.from(
      { length: IMPORT_LIMITS.maxRowsFree + 1 },
      (_, i) => `r${i}@example.com`,
    );
    const res = await plan({ file: { name: "big.txt", text: lines.join("\n") } });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body).toMatchObject({ error: "too_many_rows", limit: IMPORT_LIMITS.maxRowsFree });
    expect(body.message).toContain("has 1,001 rows; one import takes at most 1,000.");
  });

  it("too_many_rows: a file far over the limit, refused before it is read", async () => {
    const lines = Array.from({ length: IMPORT_LIMITS.maxRows }, (_, i) => `r${i}@example.com`);
    const res = await plan({ file: { name: "big.txt", text: lines.join("\n") } });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body).toMatchObject({ error: "too_many_rows", limit: IMPORT_LIMITS.maxRowsFree });
    expect(body.message).toContain("has about 10,000 rows");
  });

  it("body_too_large: a request over 10 MB", async () => {
    const text = "a".repeat(IMPORT_LIMITS.maxBodyBytes + 1);
    const res = await plan({ file: { name: "big.txt", text } });
    expect(res.status).toBe(413);
    expect((await readJson(res)).error).toBe("body_too_large");
  });

  it("refuses a plain-list meaning on a CSV, which says each row's status itself", async () => {
    const res = await plan({
      file: csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]),
      plain_list_status: "bounced",
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("plain_list_status");
  });

  it("plan_stale: a commit whose plan no longer hashes the same", async () => {
    const file = csvFile(["a@x.io,unsubscribed,unknown,sendy,,,,,,"]);
    const p = await planOk({ file });
    const res = await commit({ file, plan_hash: `${p.plan_hash}x` });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("plan_stale");
    // A different meaning for the same plain list is a different plan.
    const list = { name: "l.txt", text: "a@x.io\n" };
    const subscribed = await planOk({ file: list });
    const bounced = await planOk({ file: list, plain_list_status: "bounced" });
    expect(bounced.plan_hash).not.toBe(subscribed.plan_hash);
    expect(
      (await commit({ file: list, plain_list_status: "bounced", plan_hash: subscribed.plan_hash }))
        .status,
    ).toBe(409);
  });

  it("attestation_required: an import that confirms anyone, committed without it", async () => {
    const file = csvFile(["a@x.io,subscribed,single,sendy,,,,,,"]);
    const p = await planOk({ file });
    expect(p.attestation).toEqual({
      version: 1,
      text: "Everyone I’m importing as subscribed opted in to receive Newsletter. This isn’t a purchased, rented, or scraped list.",
      publication: "Newsletter",
    });
    const res = await commit({ file, plan_hash: p.plan_hash });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      error: "attestation_required",
      attestation: p.attestation,
    });
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(0);
  });

  it("names the publication in the attestation by the name it set (SPEC §9)", async () => {
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    const p = await planOk({ file: csvFile(["a@x.io,subscribed,single,sendy,,,,,,"]) });
    expect(p.attestation?.text).toBe(
      "Everyone I’m importing as subscribed opted in to receive Field Notes. This isn’t a purchased, rented, or scraped list.",
    );
    expect(p.attestation?.publication).toBe("Field Notes");
  });

  it("names it by the sender's display name until a publication name is set (SPEC §9)", async () => {
    const res = await fetchWith(
      { FROM_ADDRESS: '"Birds Weekly" <news@send.example.com>' },
      "/api/imports/plan",
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ file: csvFile(["a@x.io,subscribed,single,sendy,,,,,,"]) }),
      },
    );
    expect(res.status).toBe(200);
    const p: ImportPlanResponse = await readJson(res);
    expect(p.attestation?.text).toBe(
      "Everyone I’m importing as subscribed opted in to receive Birds Weekly. This isn’t a purchased, rented, or scraped list.",
    );
    expect(p.attestation?.publication).toBe("Birds Weekly");
  });

  it("calls it this newsletter with neither a publication name nor a display name (SPEC §9)", async () => {
    const res = await fetchWith({ FROM_ADDRESS: "news@send.example.com" }, "/api/imports/plan", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ file: csvFile(["a@x.io,subscribed,single,sendy,,,,,,"]) }),
    });
    expect(res.status).toBe(200);
    const p: ImportPlanResponse = await readJson(res);
    expect(p.attestation?.text).toBe(
      "Everyone I’m importing as subscribed opted in to receive this newsletter. This isn’t a purchased, rented, or scraped list.",
    );
    expect(p.attestation?.publication).toBe("this newsletter");
  });

  it("leaves the publication's name out of the plan's hash", async () => {
    const file = csvFile(["a@x.io,subscribed,single,sendy,,,,,,"]);
    const before = await planOk({ file });
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    const after = await planOk({ file });
    expect(after.attestation?.publication).toBe("Field Notes");
    expect(after.plan_hash).toBe(before.plan_hash);
    expect(after.attestation?.version).toBe(before.attestation?.version);
  });
});

describe("the plain list (SPEC §7)", () => {
  it("counts an invalid line among the rows left out, and needs no attestation to unsubscribe or bounce", async () => {
    const file = { name: "l.txt", text: "﻿a@x.io\r\n\r\nAda <b@x.io>\r\n" };
    const subscribed = await planOk({ file });
    expect(subscribed.counts).toEqual(counts({ create_confirmed: 1, invalid: 1 }));
    expect(subscribed.rows).toEqual([
      { row: 3, email: "Ada <b@x.io>", outcome: "invalid", suppression_added: false },
    ]);
    expect((await planOk({ file, plain_list_status: "unsubscribed" })).attestation).toBeNull();
    const bounced = await planOk({ file, plain_list_status: "bounced" });
    expect(bounced.attestation).toBeNull();
    expect(bounced.counts.suppression_added).toBe(1);
  });

  it("imports its rows as origin unknown, opt-in unknown", async () => {
    await importFile({ name: "l.txt", text: "a@x.io\n" });
    expect(await subscriberRow("a@x.io")).toMatchObject({
      status: "confirmed",
      origin: "unknown",
      opt_in: "unknown",
    });
  });
});

describe("what an import does to each address (SPEC §7)", () => {
  it("applies every outcome, reporting each row once", async () => {
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    await seedPending("pending@x.io");
    await seedConfirmed(["native@x.io", "leaving@x.io", "newer@x.io"]);
    await seedUnsubscribed("left@x.io");
    await subscribers.addSuppression(env.DB, "erased@x.io", "erased");
    const file = csvFile([
      `new@x.io,subscribed,double,sendy,,2024-01-01T00:00:00Z,2024-01-02T00:00:00Z,,,"{""ip"":""1.2.3.4""}"`,
      "pending@x.io,subscribed,single,mailchimp,,,,,,",
      "native@x.io,subscribed,single,sendy,,,,,,",
      "leaving@x.io,unsubscribed,unknown,sendy,,,,,,",
      "gone@x.io,unsubscribed,unknown,sendy,,,,2024-05-05T00:00:00Z,,",
      `newer@x.io,unsubscribed,unknown,sendy,,,,${yearAgo},,`,
      "left@x.io,subscribed,double,sendy,,,,,,",
      "erased@x.io,subscribed,double,sendy,,,,,,",
      "bounced@x.io,none,unknown,sendy,bounce,,,,,",
      "maybe@x.io,pending,unknown,sendy,,,,,,",
      "nobody,subscribed,double,sendy,,,,,,",
      "NEW@x.io,subscribed,double,sendy,,,,,,",
    ]);
    const p = await planOk({ file });
    const expected = counts({
      create_confirmed: 1,
      confirm_pending: 1,
      unchanged: 1,
      mark_unsubscribed: 1,
      create_unsubscribed: 1,
      kept_confirmed_newer: 1,
      kept_unsubscribed: 1,
      blocked_by_suppression: 1,
      suppression_added: 1,
      left_out: 1,
      invalid: 1,
      merged: 1,
    });
    expect(p.counts).toEqual(expected);
    expect(p.confirmed).toEqual({
      opt_in: { double: 1, single: 1, unknown: 0 },
      origin: { sendy: 1, mailchimp: 1 },
    });
    // A plan writes nothing.
    expect(await subscriberRow("new@x.io")).toBeNull();

    const result = await importFile(file);
    expect(result.counts).toEqual(expected);
    expect(result.differed).toEqual([]);
    const id = result.import.id;

    expect(await subscriberRow("new@x.io")).toMatchObject({
      status: "confirmed",
      origin: "sendy",
      opt_in: "double",
      consent_evidence: '{"ip":"1.2.3.4"}',
      import_id: id,
      confirmed_at: Date.parse("2024-01-02T00:00:00Z"),
    });
    expect(await subscriberRow("pending@x.io")).toMatchObject({
      status: "confirmed",
      origin: "mailchimp",
      opt_in: "single",
      confirm_token: null,
      import_id: id,
    });
    // A subscriber who joined here keeps their own record.
    expect(await subscriberRow("native@x.io")).toMatchObject({
      status: "confirmed",
      origin: "kestrel",
      opt_in: "double",
      import_id: null,
    });
    expect(await subscriberRow("leaving@x.io")).toMatchObject({ status: "unsubscribed" });
    expect(await subscriberRow("gone@x.io")).toMatchObject({
      status: "unsubscribed",
      import_id: id,
      unsubscribed_at: Date.parse("2024-05-05T00:00:00Z"),
    });
    expect(await subscriberRow("newer@x.io")).toMatchObject({ status: "confirmed" });
    expect(await subscriberRow("left@x.io")).toMatchObject({ status: "unsubscribed" });
    // An erased address listed as subscribed is never added, and its marker survives.
    expect(await subscriberRow("erased@x.io")).toBeNull();
    expect(await suppressionOf("erased@x.io")).toBe("erased");
    expect(await suppressionOf("bounced@x.io")).toBe("import_bounce");
    expect(await subscriberRow("bounced@x.io")).toBeNull();
    expect(await subscriberRow("maybe@x.io")).toBeNull();
    // An import sends no email.
    expect(fakeNotifications()).toEqual([]);
  });

  it("applies a suppression and a status change on one row, and reports both", async () => {
    await seedConfirmed("a@x.io");
    const file = csvFile(["a@x.io,unsubscribed,unknown,sendy,complaint,,,,,"]);
    const p = await planOk({ file });
    expect(p.counts).toEqual(counts({ mark_unsubscribed: 1 }));
    expect(p.suppressions_added).toBe(1);
    expect(p.rows).toEqual([
      { row: 1, email: "a@x.io", outcome: "mark_unsubscribed", suppression_added: true },
    ]);
    await importFile(file);
    expect(await subscriberRow("a@x.io")).toMatchObject({ status: "unsubscribed" });
    expect(await suppressionOf("a@x.io")).toBe("import_complaint");
  });

  it("never replaces a suppression already here, the first one standing", async () => {
    await subscribers.addSuppression(env.DB, "a@x.io", "manual");
    const p = await planOk({ file: csvFile(["a@x.io,none,unknown,sendy,complaint,,,,,"]) });
    expect(p.counts).toEqual(counts({ left_out: 1 }));
    await importFile(csvFile(["a@x.io,none,unknown,sendy,complaint,,,,,"]));
    expect(await suppressionOf("a@x.io")).toBe("manual");
  });

  it("replaces an erased marker with a bounce or complaint, so the address is still sent no confirmation", async () => {
    await subscribers.addSuppression(env.DB, "a@x.io", "erased");
    await subscribers.addSuppression(env.DB, "b@x.io", "erased");
    const file = csvFile([
      "a@x.io,none,unknown,sendy,complaint,,,,,",
      "b@x.io,subscribed,double,sendy,erased,,,,,",
    ]);
    const p = await planOk({ file });
    expect(p.counts).toEqual(counts({ suppression_added: 1, blocked_by_suppression: 1 }));
    await importFile(file);
    expect(await suppressionOf("a@x.io")).toBe("import_complaint");
    expect(await subscribers.blocksConfirmation(env.DB, "a@x.io")).toBe(true);
    expect(await suppressionOf("b@x.io")).toBe("erased");
    expect(await subscriberRow("b@x.io")).toBeNull();
  });

  it("never confirms a reader who left and was put back to pending by the form (I2)", async () => {
    await seedUnsubscribed("left@x.io");
    // Anyone can type the address into the public form, which re-arms it as pending.
    const claimedAt = Date.now();
    await env.DB.prepare("UPDATE subscribers SET confirm_attempt_at = ? WHERE email = 'left@x.io'")
      .bind(claimedAt)
      .run();
    expect(
      await subscribers.armConfirmation(env.DB, "id-left@x.io", "tok", claimedAt, "unsubscribed"),
    ).toBe(true);
    expect(await subscriberRow("left@x.io")).toMatchObject({ status: "pending" });

    const file = csvFile(["left@x.io,subscribed,double,sendy,,,,,,"]);
    const p = await planOk({ file });
    expect(p.counts).toEqual(counts({ kept_unsubscribed: 1 }));
    expect(p.attestation).toBeNull();
    await importFile(file);
    expect(await subscriberRow("left@x.io")).toMatchObject({ status: "pending" });
    // Its owner's own confirmation still brings it back.
    expect((await subscribers.confirm(env.DB, "tok", 0))?.status).toBe("confirmed");
  });

  it("unsubscribes a reader confirmed here when the file gives no time for the unsubscribe", async () => {
    await seedConfirmed("a@x.io");
    const p = await planOk({ file: csvFile(["a@x.io,unsubscribed,unknown,sendy,,,,,,"]) });
    // With no time to compare, leaving wins: no mail to someone the source says left.
    expect(p.counts).toEqual(counts({ mark_unsubscribed: 1 }));
  });

  it("confirms a subscribed row that brings its own bounce, suppressed, so it never joins an audience", async () => {
    await frozenSend(Date.now() + 3_600_000);
    const p = await planOk({ file: csvFile(["a@x.io,subscribed,double,sendy,bounce,,,,,"]) });
    expect(p.counts.create_confirmed).toBe(1);
    expect(p.sends_growing).toEqual([]);
    await importFile(csvFile(["a@x.io,subscribed,double,sendy,bounce,,,,,"]));
    expect(await subscriberRow("a@x.io")).toMatchObject({ status: "confirmed" });
    expect(await suppressionOf("a@x.io")).toBe("import_bounce");
    expect(await subscribers.audienceCount(env.DB)).toBe(0);
  });

  it("merges an address's repeats before classifying it", async () => {
    const p = await planOk({
      file: csvFile([
        "a@x.io,subscribed,double,sendy,,,,,,",
        "A@x.io,unsubscribed,unknown,sendy,,,,,,",
        "a@x.io,pending,single,other,manual,,,,,",
      ]),
    });
    expect(p.counts).toEqual(counts({ create_unsubscribed: 1, merged: 2 }));
    expect(p.suppressions_added).toBe(1);
    expect(p.rows.map((r) => [r.row, r.outcome])).toEqual([
      [1, "create_unsubscribed"],
      [2, "merged"],
      [3, "merged"],
    ]);
  });
});

describe("a confirmation here makes the consent this app's (SPEC §7)", () => {
  it("clears the import's provenance and records the confirming IP", async () => {
    const result = await importFile(csvFile(["a@x.io,unsubscribed,single,sendy,,,,,,"]));
    expect(await subscriberRow("a@x.io")).toMatchObject({ import_id: result.import.id });
    // The person subscribes again here and presses Confirm.
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'pending', confirm_token = 'tok', confirm_sent_at = ? WHERE email = 'a@x.io'",
    )
      .bind(Date.now())
      .run();
    await subscribers.confirm(env.DB, "tok", 0, "203.0.113.9");
    expect(await subscriberRow("a@x.io")).toMatchObject({
      status: "confirmed",
      origin: "kestrel",
      opt_in: "double",
      import_id: null,
      consent_evidence: '{"confirmed_ip":"203.0.113.9"}',
    });
  });
});

describe("provenance is keyed on the import, not on the file's claims (SPEC §7)", () => {
  it("reads a row claiming this app's double opt-in as imported", async () => {
    const result = await importFile(csvFile(["a@x.io,subscribed,double,kestrel,,,,,,"]));
    expect(await subscriberRow("a@x.io")).toMatchObject({
      origin: "kestrel",
      opt_in: "double",
      import_id: result.import.id,
    });
  });
});

describe("the record and the notice (SPEC §8)", () => {
  it("keeps who committed it, the attestation's version, the file, and the counts, and no subscriber's address", async () => {
    const file = csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]);
    const result = await importFile(file);
    const row = await env.DB.prepare("SELECT * FROM imports").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      id: result.import.id,
      principal_kind: "human",
      principal_email: "tester@example.com",
      attestation_version: 1,
      file_name: "list.csv",
      plan_hash: result.import.plan_hash,
      suppressions_added: 0,
    });
    expect(JSON.parse(row?.counts as string)).toEqual(counts({ create_confirmed: 1 }));
    expect(JSON.stringify(row)).not.toContain("a@x.io");
    // A person's import needs no notice: they saw it happen.
    expect(await count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
  });

  it("keeps no attestation for an import that confirms no one", async () => {
    const result = await importFile(csvFile(["a@x.io,unsubscribed,unknown,sendy,,,,,,"]));
    expect(result.import.attestation_version).toBeNull();
  });

  it("lets a service token attest, records it as the service, and emails the publisher the counts", async () => {
    await updateSettings(env.DB, { notifications: { to: "publisher@example.com" } });
    const service = { ...(await adminAuth({})), "content-type": "application/json" };
    const file = csvFile([
      "a@x.io,subscribed,double,sendy,,,,,,",
      "b@x.io,unsubscribed,unknown,sendy,,,,,,",
    ]);
    const p = await planOk({ file });
    const res = await commit({ file, plan_hash: p.plan_hash, attestation: ATTEST }, service);
    expect(res.status).toBe(201);
    const result: ImportCommitResponse = await res.json();
    expect(result.import.principal).toEqual({ kind: "service", email: null });

    await notifyPublisher(env, new Budget(50));
    const sent = fakeNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Claude imported 1 subscribers from list.csv");
    expect(sent[0]?.text).toContain("Confirmed as subscribers: 1. Unsubscribed: 1.");
    expect(sent[0]?.text).toContain("Claude attested for you");
    expect(sent[0]?.text).toContain("/dashboard/?to=/subscribers");
    // Told once.
    await notifyPublisher(env, new Budget(50));
    expect(fakeNotifications()).toHaveLength(1);
  });
});

describe("a person sees every send an import would grow (SPEC §7, I6)", () => {
  it("names each scheduled send and what it gains, and refuses a commit that doesn't acknowledge it", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const file = csvFile([
      "a@x.io,subscribed,double,sendy,,,,,,",
      "b@x.io,subscribed,double,sendy,,,,,,",
    ]);
    const p = await planOk({ file });
    expect(p.sends_growing).toEqual([
      { id: send.id, subject: send.subject, fire_at: send.fire_at, gains: 2 },
    ]);
    const refused = await commit({ file, plan_hash: p.plan_hash, attestation: ATTEST });
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      error: "sends_acknowledgement_required",
      sends: p.sends_growing,
    });
    const ok = await commit({
      file,
      plan_hash: p.plan_hash,
      attestation: ATTEST,
      acknowledge_sends: [send.id],
    });
    expect(ok.status).toBe(201);
    expect(await subscribers.audienceCount(env.DB)).toBe(2);
  });

  it("counts a send that fired but stopped before fixing its audience as one that would grow", async () => {
    const send = await frozenSend(Date.now() - 60_000);
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(Date.now(), send.id)
      .run();
    const p = await planOk({ file: csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]) });
    expect(p.sends_growing.map((s) => s.id)).toEqual([send.id]);
    await env.DB.prepare("UPDATE sends SET audience_resolved_at = ? WHERE id = ?")
      .bind(Date.now(), send.id)
      .run();
    expect(
      (await planOk({ file: csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]) })).sends_growing,
    ).toEqual([]);
  });

  it("refuses a service token's commit that would grow one, acknowledged or not, until a person does it", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const service = { ...(await adminAuth({})), "content-type": "application/json" };
    const file = csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]);
    const p = await planOk({ file });
    const res = await commit(
      { file, plan_hash: p.plan_hash, attestation: ATTEST, acknowledge_sends: [send.id] },
      service,
    );
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("sends_acknowledgement_required");
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(0);
    // The publisher finishes it in the dashboard with the same file: the same plan.
    expect((await planOk({ file })).plan_hash).toBe(p.plan_hash);
    expect(
      (
        await commit({
          file,
          plan_hash: p.plan_hash,
          attestation: ATTEST,
          acknowledge_sends: [send.id],
        })
      ).status,
    ).toBe(201);
  });
});

describe("a commit is idempotent and atomic (SPEC §7)", () => {
  it("returns the stored result for a replayed commit and writes nothing twice", async () => {
    const file = csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]);
    const p = await planOk({ file });
    const body = { file, plan_hash: p.plan_hash, attestation: ATTEST };
    const first: ImportCommitResponse = await (await commit(body)).json();
    const again = await commit(body);
    expect(again.status).toBe(200);
    const replay: ImportCommitResponse = await again.json();
    expect(replay).toMatchObject({ replayed: true, import: first.import, counts: first.counts });
    expect(await count("SELECT COUNT(*) AS n FROM imports")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(1);
  });

  it("plans the same file afresh after the list has moved, rather than replaying its first import", async () => {
    await subscribers.addSuppression(env.DB, "b@x.io", "manual");
    const file = csvFile([
      "a@x.io,subscribed,double,sendy,,,,,,",
      "b@x.io,subscribed,double,sendy,,,,,,",
    ]);
    const first = await importFile(file);
    expect(first.counts.blocked_by_suppression).toBe(1);
    await subscribers.clearSuppression(env.DB, "b@x.io");
    const again = await importFile(file);
    expect(again.replayed).toBe(false);
    expect(again.counts).toEqual(counts({ unchanged: 1, create_confirmed: 1 }));
    expect(await subscriberRow("b@x.io")).toMatchObject({ status: "confirmed" });
  });

  it("refuses a plan made before another import was committed", async () => {
    const file = csvFile(["a@x.io,unsubscribed,unknown,sendy,,,,,,"]);
    const p = await planOk({ file });
    await importFile(csvFile(["b@x.io,unsubscribed,unknown,sendy,,,,,,"]));
    const res = await commit({ file, plan_hash: p.plan_hash });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("plan_stale");
  });

  it("answers a commit that lost the race to the same plan with the winner's record", async () => {
    const p = await planImport(
      env.DB,
      { ...csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]), plainListStatus: null },
      planOptions,
    );
    const winner = await commitImport(env.DB, p, HUMAN, Date.now());
    const loser = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(loser).toMatchObject({ replayed: true, import: { id: winner.import.id } });
    expect(await count("SELECT COUNT(*) AS n FROM imports")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(1);
  });

  it("answers what was applied when correcting the record fails after the batch, never a replay", async () => {
    await seedPending("reader@x.io");
    const file = csvFile([
      "reader@x.io,subscribed,double,sendy,,,,,,",
      "new@x.io,subscribed,double,sendy,,,,,,",
    ]);
    const p = await planImport(env.DB, { ...file, plainListStatus: null }, planOptions);
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'reader@x.io'",
    ).run();
    vi.spyOn(importsDb, "setImportCounts").mockRejectedValue(new Error("D1 went away"));
    allowErrorLogs("import.incomplete");
    const error = vi.spyOn(console, "error");
    const result = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(result.replayed).toBe(false);
    expect(result.counts).toEqual(counts({ create_confirmed: 1, kept_unsubscribed: 1 }));
    expect(logged(error).map((l) => [l.event, l.step])).toEqual([["import.incomplete", "counts"]]);
  });

  it("writes nothing when a write fails part-way", async () => {
    await seedConfirmed("leaving@x.io");
    const p = await planImport(
      env.DB,
      {
        ...csvFile([
          "leaving@x.io,unsubscribed,unknown,sendy,bounce,,,,,",
          "a@x.io,subscribed,double,sendy,,,,,,",
        ]),
        plainListStatus: null,
      },
      planOptions,
    );
    // An origin the schema refuses, on the last subscriber the batch adds.
    const bad = p.planned.find((r) => r.row.email === "a@x.io");
    if (bad) {
      bad.row.origin = "NOT VALID";
    }
    await expect(commitImport(env.DB, p, HUMAN, Date.now())).rejects.toThrow();
    expect(await subscriberRow("leaving@x.io")).toMatchObject({ status: "confirmed" });
    expect(await suppressionOf("leaving@x.io")).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM imports")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(1);
  });
});

describe("the list moving between the plan and the commit (SPEC §7)", () => {
  it("never confirms a reader who unsubscribed in between, and reports the difference", async () => {
    await seedPending("reader@x.io");
    const p = await planImport(
      env.DB,
      {
        ...csvFile([
          "reader@x.io,subscribed,double,sendy,,,,,,",
          "new@x.io,subscribed,double,sendy,,,,,,",
        ]),
        plainListStatus: null,
      },
      planOptions,
    );
    expect(p.counts.confirm_pending).toBe(1);
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'reader@x.io'",
    ).run();
    await subscribers.addSuppression(env.DB, "new@x.io", "complaint");

    const result = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(await subscriberRow("reader@x.io")).toMatchObject({ status: "unsubscribed" });
    expect(await subscriberRow("new@x.io")).toBeNull();
    expect(result.differed).toEqual([
      { row: 1, email: "reader@x.io", planned: "confirm_pending", applied: "kept_unsubscribed" },
      { row: 2, email: "new@x.io", planned: "create_confirmed", applied: "blocked_by_suppression" },
    ]);
    expect(result.counts).toEqual(counts({ kept_unsubscribed: 1, blocked_by_suppression: 1 }));
    // The record keeps the counts as applied.
    const row = await env.DB.prepare("SELECT counts FROM imports").first<{ counts: string }>();
    expect(JSON.parse(row?.counts ?? "{}")).toEqual(result.counts);
  });

  it("commits through the API when a reader unsubscribes after the plan, and answers what was applied", async () => {
    await seedPending("reader@x.io");
    const file = csvFile([
      "reader@x.io,subscribed,double,sendy,,,,,,",
      "new@x.io,subscribed,double,sendy,,,,,,",
    ]);
    const p = await planOk({ file });
    expect(p.counts.confirm_pending).toBe(1);
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'reader@x.io'",
    ).run();
    const res = await commit({ file, plan_hash: p.plan_hash, attestation: ATTEST });
    expect(res.status).toBe(201);
    const result: ImportCommitResponse = await res.json();
    expect(result.counts).toEqual(counts({ create_confirmed: 1, kept_unsubscribed: 1 }));
    expect(result.rows).toEqual([
      { row: 1, email: "reader@x.io", outcome: "kept_unsubscribed", suppression_added: false },
    ]);
    expect(await subscriberRow("reader@x.io")).toMatchObject({ status: "unsubscribed" });
  });

  it("never confirms a pending reader who left and was re-armed in between (I2)", async () => {
    await seedPending("reader@x.io");
    const p = await planImport(
      env.DB,
      { ...csvFile(["reader@x.io,subscribed,double,sendy,,,,,,"]), plainListStatus: null },
      planOptions,
    );
    expect(p.counts.confirm_pending).toBe(1);
    // The reader unsubscribes, and the form puts them back to pending, before the commit.
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'pending', unsubscribed_at = ? WHERE email = 'reader@x.io'",
    )
      .bind(Date.now())
      .run();
    const result = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(await subscriberRow("reader@x.io")).toMatchObject({ status: "pending" });
    expect(result.differed).toEqual([
      { row: 1, email: "reader@x.io", planned: "confirm_pending", applied: "kept_unsubscribed" },
    ]);
  });

  it("keeps a suppression added here in between, never replacing it with the file's", async () => {
    const p = await planImport(
      env.DB,
      { ...csvFile(["a@x.io,none,unknown,sendy,bounce,,,,,"]), plainListStatus: null },
      planOptions,
    );
    expect(p.counts.suppression_added).toBe(1);
    await subscribers.addSuppression(env.DB, "a@x.io", "manual");
    const result = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(await suppressionOf("a@x.io")).toBe("manual");
    expect(result.differed).toEqual([
      { row: 1, email: "a@x.io", planned: "suppression_added", applied: "left_out" },
    ]);
    expect(result.suppressions_added).toBe(0);
  });

  it("confirms an address that subscribed here in between, rather than adding it twice", async () => {
    const p = await planImport(
      env.DB,
      { ...csvFile(["a@x.io,subscribed,double,sendy,,,,,,"]), plainListStatus: null },
      planOptions,
    );
    await seedPending("a@x.io");
    const result = await commitImport(env.DB, p, HUMAN, Date.now());
    expect(result.differed).toEqual([
      { row: 1, email: "a@x.io", planned: "create_confirmed", applied: "confirm_pending" },
    ]);
    expect(await subscriberRow("a@x.io")).toMatchObject({
      status: "confirmed",
      import_id: result.import.id,
    });
  });
});

// The nth address of a generated list, zero-padded so address order is numeric order.
function address(n: number): string {
  return `r${String(n).padStart(6, "0")}@example.com`;
}

async function seedAddresses(confirmed: string[], suppressedOnly: string[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at)
       SELECT 's-' || value, value, 'confirmed', 'u-' || value, 1, 2 FROM json_each(?)`,
    ).bind(JSON.stringify(confirmed)),
    env.DB.prepare(
      "INSERT INTO suppressions (email, reason, created_at) SELECT value, 'complaint', 1 FROM json_each(?)",
    ).bind(JSON.stringify(suppressedOnly)),
  ]);
}

async function exportPage(after: string | null = null): Promise<ExportResponse> {
  const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
  const res = await SELF.fetch(`${base}/api/subscribers/export${query}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return readJson(res);
}

/** Every page of the export from `after`, following `next` to the end. */
async function exportAll(after: string | null = null): Promise<ExportResponse[]> {
  const pages: ExportResponse[] = [];
  let next: string | null = after;
  do {
    const page = await exportPage(next);
    pages.push(page);
    next = page.next;
  } while (next !== null);
  return pages;
}

describe("the export, and the round trip (SPEC §7)", () => {
  async function seedList() {
    const confirmedAt = Date.parse("2025-06-01T10:00:00Z");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at, consent_evidence)
         VALUES ('1', 'native@x.io', 'confirmed', 'u1', ?, ?, '{"confirmed_ip":"203.0.113.7"}')`,
      ).bind(confirmedAt - 60_000, confirmedAt),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at) VALUES ('2', 'bouncy@x.io', 'confirmed', 'u2', 1, 2)",
      ),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribed_at) VALUES ('3', 'left@x.io', 'unsubscribed', 'u3', 1, 3)",
      ),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('4', 'waiting@x.io', 'pending', 'u4', 1)",
      ),
    ]);
    await subscribers.addSuppression(env.DB, "bouncy@x.io", "bounce");
    await subscribers.addSuppression(env.DB, "complainer@x.io", "complaint");
    await subscribers.addSuppression(env.DB, "erased@x.io", "erased");
  }

  it("writes the whole list in the format, including suppressed addresses with no subscriber", async () => {
    await seedList();
    const res = await SELF.fetch(`${base}/api/subscribers/export`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body: ExportResponse = await readJson(res);
    expect(body.format).toBe(IMPORT_FORMAT);
    expect(body.next).toBe(null);
    const byEmail = Object.fromEntries(body.subscribers.map((r) => [r.email, r]));
    expect(byEmail["native@x.io"]).toMatchObject({
      status: "subscribed",
      origin: "kestrel",
      opt_in: "double",
      confirmed_at: "2025-06-01T10:00:00.000Z",
      evidence: '{"confirmed_ip":"203.0.113.7"}',
      suppression: null,
    });
    expect(byEmail["bouncy@x.io"]).toMatchObject({ status: "subscribed", suppression: "bounce" });
    expect(byEmail["complainer@x.io"]).toMatchObject({ status: "none", suppression: "complaint" });
    expect(byEmail["erased@x.io"]).toMatchObject({ status: "none", suppression: "erased" });
    expect(body.subscribers.map((r) => r.email)).toEqual([
      "bouncy@x.io",
      "complainer@x.io",
      "erased@x.io",
      "left@x.io",
      "native@x.io",
      "waiting@x.io",
    ]);
  });

  it("imports into a fresh instance with the same states and suppressions, confirmations arriving as imported", async () => {
    await seedList();
    const text = toImportCsv((await exportAll()).flatMap((p) => p.subscribers));
    await resetDatabase();

    const result = await importFile({ name: "export.csv", text });
    expect(result.counts).toEqual(
      counts({ create_confirmed: 2, create_unsubscribed: 1, suppression_added: 2, left_out: 1 }),
    );
    const { results: states } = await env.DB.prepare(
      "SELECT email, status FROM subscribers ORDER BY email",
    ).all();
    expect(states).toEqual([
      { email: "bouncy@x.io", status: "confirmed" },
      { email: "left@x.io", status: "unsubscribed" },
      { email: "native@x.io", status: "confirmed" },
    ]);
    const { results: suppressions } = await env.DB.prepare(
      "SELECT email, reason FROM suppressions ORDER BY email",
    ).all();
    expect(suppressions).toEqual([
      { email: "bouncy@x.io", reason: "import_bounce" },
      { email: "complainer@x.io", reason: "import_complaint" },
      { email: "erased@x.io", reason: "erased" },
    ]);
    expect(await subscriberRow("native@x.io")).toMatchObject({
      origin: "kestrel",
      opt_in: "double",
      import_id: result.import.id,
      consent_evidence: '{"confirmed_ip":"203.0.113.7"}',
      confirmed_at: Date.parse("2025-06-01T10:00:00Z"),
    });
  });
});

describe("the export, a page at a time (SPEC §8)", () => {
  const FREE_PAGE = EXPORT_PAGE_ROWS.free;

  it("reads every address exactly once across its pages, suppression-only addresses included", async () => {
    // Subscribers and suppression-only addresses interleave in address order, so both halves
    // of every page's read meet at its boundary.
    const subscribed = Array.from({ length: 1_600 }, (_, i) => address(i * 2));
    const suppressed = Array.from({ length: 900 }, (_, i) => address(i * 2 + 1));
    await seedAddresses(subscribed, suppressed);

    const pages = await exportAll();
    expect(pages.map((p) => p.subscribers.length)).toEqual([FREE_PAGE, FREE_PAGE, 500]);
    expect(new Set(pages.map((p) => p.exported_at)).size).toBe(1);
    const emails = pages.flatMap((p) => p.subscribers.map((r) => r.email));
    expect(emails).toEqual([...subscribed, ...suppressed].sort());
    expect(pages.flatMap((p) => p.subscribers).filter((r) => r.status === "none")).toHaveLength(
      900,
    );
  });

  it("never skips or repeats an address when the list changes between pages", async () => {
    const start = Array.from({ length: 2_000 }, (_, i) => address(i * 10));
    await seedAddresses(start, []);

    const first = await exportPage();
    const lastRead = first.subscribers.at(-1)?.email ?? "";
    // Behind the cursor: one added, one removed. Ahead of it: the same, and one suppressed.
    await seedAddresses([address(5)], []);
    await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(address(10)).run();
    await seedAddresses([address(15_005)], []);
    await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(address(15_000)).run();
    await subscribers.addSuppression(env.DB, address(16_000), "manual");
    await subscribers.addSuppression(env.DB, address(16_001), "manual");

    const rest = await exportAll(first.next);
    const emails = [first, ...rest].flatMap((p) => p.subscribers.map((r) => r.email));
    expect(new Set(emails).size).toBe(emails.length);
    // Every address on the list for the whole export, once; the changes land where they fall.
    const throughout = start.filter((e) => e !== address(10) && e !== address(15_000));
    expect(throughout.every((e) => emails.includes(e))).toBe(true);
    expect(emails.includes(address(5))).toBe(false);
    expect(emails.includes(address(15_005))).toBe(true);
    expect(emails.includes(address(15_000))).toBe(false);
    expect(emails.includes(address(16_001))).toBe(true);
    expect(emails.filter((e) => e > lastRead)).toEqual(
      [...throughout.filter((e) => e > lastRead), address(15_005), address(16_001)].sort(),
    );
  });

  it("takes 10,000 rows a page on Workers Paid", async () => {
    await seedAddresses(
      Array.from({ length: FREE_PAGE + 1 }, (_, i) => address(i)),
      [],
    );
    const res = await fetchWith(PAID, `${base}/api/subscribers/export`, { headers: AUTH });
    const body: ExportResponse = await readJson(res);
    expect(body.subscribers).toHaveLength(FREE_PAGE + 1);
    expect(body.next).toBe(null);
  });

  it("refuses a cursor this server didn't issue, naming the field (API principle 7)", async () => {
    const forged = btoa(JSON.stringify({ v: 2, after: "a@x.io", at: 1 }));
    for (const after of ["nonsense", "", forged, "eyJ2IjoxfQ"]) {
      const res = await SELF.fetch(
        `${base}/api/subscribers/export?after=${encodeURIComponent(after)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      expect((await readJson(res)).field).toBe("after");
    }
  });
});

describe("an import that leaves the list past what Workers Free suits (SPEC §7)", () => {
  async function planOf(
    file: { name: string; text: string },
    extra: Record<string, unknown> = {},
    vars: Record<string, string> = {},
  ) {
    const res = await fetchWith(vars, `${base}/api/imports/plan`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ file, ...extra }),
    });
    expect(res.status).toBe(200);
    return (await readJson(res)) as ImportPlanResponse;
  }

  const adding = (added: number) => ({
    name: "new.txt",
    text: addresses(added)
      .map((e) => `new.${e}`)
      .join("\n"),
  });

  it("advises Workers Paid on Free's limits once the confirmed list it leaves passes 1,000, and still plans", async () => {
    await seedConfirmed(addresses(600));
    expect((await planOf(adding(400))).workers_plan_advice).toBe(null); // 1,000: within
    const over = await planOf(adding(401));
    expect(over.counts.create_confirmed).toBe(401);
    expect(over.workers_plan_advice).toBe(
      "On the Workers Free plan’s limits, this import leaves 1,001 confirmed subscribers. Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day’s database writes and stop this newsletter until midnight UTC. Move to Workers Paid, or, if the account is on it already, set SUBREQUEST_BUDGET to 10000.",
    );
  });

  it("counts the confirmed subscribers it unsubscribes as leaving the list", async () => {
    const emails = addresses(1_001);
    await seedConfirmed(emails);
    const leaving = await planOf(
      { name: "left.txt", text: `${emails[0]}\n` },
      { plain_list_status: "unsubscribed" },
    );
    expect(leaving.counts.mark_unsubscribed).toBe(1);
    expect(leaving.workers_plan_advice).toBe(null); // 1,000 left confirmed
  });

  it("counts the pending subscribers it confirms as joining the confirmed list", async () => {
    await seedConfirmed(addresses(1_000));
    await seedPending("waiting@x.io");
    const confirming = await planOf({ name: "list.txt", text: "waiting@x.io\n" });
    expect(confirming.counts.confirm_pending).toBe(1);
    expect(confirming.workers_plan_advice).toMatch(
      /this import leaves 1,001 confirmed subscribers/,
    );
  });

  it("subtracts nothing for a pending subscriber it unsubscribes", async () => {
    await seedConfirmed(addresses(1_001));
    await seedPending("waiting@x.io");
    const leaving = await planOf(
      { name: "left.txt", text: "waiting@x.io\n" },
      { plain_list_status: "unsubscribed" },
    );
    expect(leaving.counts.mark_unsubscribed).toBe(1);
    // Still 1,001 confirmed: the one who left was never on the confirmed list.
    expect(leaving.workers_plan_advice).toMatch(/this import leaves 1,001 confirmed subscribers/);
  });

  it("carries no advice on Workers Paid, and the advice never changes the plan's hash", async () => {
    await seedConfirmed(addresses(1_000));
    const free = await planOf(adding(1));
    const paid = await planOf(adding(1), {}, PAID);
    expect(free.workers_plan_advice).not.toBe(null);
    expect(paid.workers_plan_advice).toBe(null);
    expect(paid.plan_hash).toBe(free.plan_hash);
  });
});

describe("a 10,000-row import (SPEC §7)", () => {
  it("plans and commits within the batch's statement count and D1's per-value size", async () => {
    const evidence = JSON.stringify({ note: "x".repeat(400) }).replace(/"/g, '""');
    const lines = Array.from(
      { length: IMPORT_LIMITS.maxRows },
      (_, i) =>
        `r${String(i).padStart(5, "0")}@example.com,${i % 10 === 0 ? "unsubscribed" : "subscribed"},single,sendy,${i % 50 === 0 ? "bounce" : ""},2024-01-01T00:00:00Z,,,,"${evidence}"`,
    );
    const input = { ...csvFile(lines), plainListStatus: null };
    expect(input.text.length).toBeGreaterThan(4_000_000);

    const guarded = guardD1(env.DB);
    const p = await planImport(guarded.db, input, planOptions);
    expect(p.counts.create_confirmed).toBe(9_000);
    const planStatements = guarded.statements;
    const result = await commitImport(guarded.db, p, HUMAN, Date.now());
    const commitStatements = guarded.statements - planStatements;
    expect(result.counts).toMatchObject({ create_confirmed: 9_000, create_unsubscribed: 1_000 });
    expect(result.suppressions_added).toBe(200);
    // A few dozen statements at most: inside Workers Free's 50 queries per invocation.
    expect(planStatements + commitStatements).toBeLessThanOrEqual(50);
    expect(await count("SELECT COUNT(*) AS n FROM subscribers")).toBe(10_000);
  });

  it("is refused on Workers Free above its lower limit, and taken on Paid", async () => {
    expect(maxImportRows(getConfig(env).subrequestBudget).maxRows).toBe(IMPORT_LIMITS.maxRowsFree);
    expect(maxImportRows(1000).maxRows).toBe(IMPORT_LIMITS.maxRows);
  });
});
