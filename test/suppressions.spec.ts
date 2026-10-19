// GET /api/suppressions pages like the other lists (docs/API.md principle 8): every
// suppression is readable through its pages, however many an import brought, filtered by
// reason and address.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Suppression, SuppressionReason } from "../shared/subscribers";
import { resetDatabase } from "./support/fixtures";
import { AUTH, base, readJson } from "./support/http";

/** Suppressions in one statement, however many: each `[email, reason, created_at]`. */
async function seedSuppressions(rows: readonly [string, SuppressionReason, number][]) {
  await env.DB.prepare(
    `INSERT INTO suppressions (email, reason, detail, created_at)
     SELECT value ->> 0, value ->> 1, NULL, value ->> 2 FROM json_each(?)`,
  )
    .bind(JSON.stringify(rows))
    .run();
}

const list = (query = "") => SELF.fetch(`${base}/api/suppressions?${query}`, { headers: AUTH });

beforeEach(resetDatabase);

describe("GET /api/suppressions pages (SPEC §7)", () => {
  it("reads every one of more than 1,000 suppressions through its pages, newest first, each once", async () => {
    const now = Date.now();
    const reasons: SuppressionReason[] = ["bounce", "import_bounce", "manual"];
    // Each pair shares a time, so the order needs its tiebreak to page without repeating or
    // skipping a row.
    const rows = Array.from(
      { length: 1205 },
      (_, i) =>
        [
          `s${String(i).padStart(4, "0")}@example.com`,
          reasons[i % 3] as SuppressionReason,
          now - Math.floor(i / 2) * 1000,
        ] as [string, SuppressionReason, number],
    );
    await seedSuppressions(rows);

    const read: Suppression[] = [];
    for (let offset = 0; ; offset += 200) {
      const res = await list(`limit=200&offset=${offset}`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.page).toEqual({
        total: 1205,
        limit: 200,
        offset,
        sort: "created_at",
        dir: "desc",
      });
      read.push(...body.suppressions);
      if (body.suppressions.length < 200) {
        break;
      }
    }

    expect(read).toHaveLength(1205);
    expect(new Set(read.map((s) => s.email)).size).toBe(1205);
    const times = read.map((s) => s.created_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(read[0]).toEqual({
      email: "s0001@example.com",
      reason: "import_bounce",
      detail: null,
      created_at: now,
    });
  });

  it("answers 50 a page when no limit is given", async () => {
    const now = Date.now();
    await seedSuppressions(
      Array.from({ length: 60 }, (_, i) => [`p${i}@example.com`, "bounce", now - i] as const),
    );
    const body = await readJson(await list());
    expect(body.suppressions).toHaveLength(50);
    expect(body.page).toEqual({ total: 60, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
  });

  it("filters by reason, and counts the filtered rows in its total", async () => {
    const now = Date.now();
    await seedSuppressions([
      ["a@example.com", "bounce", now],
      ["b@example.com", "manual", now - 1],
      ["c@example.com", "import_bounce", now - 2],
      ["d@example.com", "manual", now - 3],
    ]);
    const body = await readJson(await list("reason=manual"));
    expect(body.suppressions.map((s: Suppression) => s.email)).toEqual([
      "b@example.com",
      "d@example.com",
    ]);
    expect(body.page.total).toBe(2);
  });

  it("searches by address, case-insensitively, with LIKE's wildcards read literally", async () => {
    const now = Date.now();
    await seedSuppressions([
      ["ada_l@example.com", "bounce", now],
      ["adaxl@example.com", "bounce", now - 1],
      ["grace@example.org", "manual", now - 2],
    ]);
    const body = await readJson(await list(`search=${encodeURIComponent(" ADA_L ")}`));
    expect(body.suppressions.map((s: Suppression) => s.email)).toEqual(["ada_l@example.com"]);
    expect(body.page.total).toBe(1);

    const both = await readJson(await list("search=example.org&reason=bounce"));
    expect(both.suppressions).toEqual([]);
    expect(both.page.total).toBe(0);
  });

  it("sorts by a declared key in either direction", async () => {
    const now = Date.now();
    await seedSuppressions([
      ["b@example.com", "manual", now],
      ["c@example.com", "bounce", now - 1],
      ["a@example.com", "import_bounce", now - 2],
    ]);
    const body = await readJson(await list("sort=email&dir=asc"));
    expect(body.suppressions.map((s: Suppression) => s.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(body.page).toMatchObject({ sort: "email", dir: "asc" });
  });

  it("refuses a reason it doesn't take, a sort it doesn't list, and a parameter it doesn't declare, naming each", async () => {
    for (const [query, field] of [
      ["reason=complaint", "reason"],
      ["sort=detail", "sort"],
      ["cause=complaint", "cause"],
    ]) {
      const res = await list(query);
      expect(res.status, query).toBe(400);
      expect((await readJson(res)).field, query).toBe(field);
    }
  });
});
