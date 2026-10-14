/**
 * What an import costs in D1's rows, by what it does to each address. Workers Free's D1
 * refuses every query once a day's written rows are spent, and the import plan warns from
 * `importWrites`, the estimate of an import's rows from its counts. Each case here commits an
 * import and holds what D1 reported to that estimate exactly, so a change that moves an
 * import's cost fails here until the estimate moves with it (SPEC §7).
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { importWrites } from "../shared/daily_writes";
import { IMPORT_LIMITS } from "../shared/imports";
import { importWritesSince } from "../src/db/imports";
import type { Principal } from "../src/router";
import { commitImport, planImport } from "../src/services/imports";
import { meterD1 } from "./support/d1_guard";
import { addresses, resetDatabase, seedConfirmed } from "./support/fixtures";

const ROWS = 200;
const HEADER =
  "email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence";
const EVIDENCE = '"{""signup_ip"":""203.0.113.7""}"';
const HUMAN: Principal = { kind: "human", email: "publisher@example.com", via: "dev" };

async function seedPending(emails: readonly string[]): Promise<void> {
  for (const e of emails) {
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, confirm_sent_at, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
    )
      .bind(`id-${e}`, e, `cfm-${e}`, Date.now(), `uns-${e}`, Date.now())
      .run();
  }
}

/** Commit `ROWS` rows of one kind; answer what D1 reported written and what the estimate says. */
async function costOf(
  line: (email: string) => string,
  seed?: (emails: readonly string[]) => Promise<void>,
  principal: Principal = HUMAN,
): Promise<{ written: number; estimated: number; recorded: number }> {
  const emails = addresses(ROWS);
  await seed?.(emails);
  const text = `${[HEADER, ...emails.map(line)].join("\r\n")}\r\n`;
  const plan = await planImport(
    env.DB,
    { name: "list.csv", text, plainListStatus: null },
    { maxRows: IMPORT_LIMITS.maxRows, maxRowsReason: null, publication: "Field Notes" },
  );
  const meter = meterD1(env.DB);
  const result = await commitImport(meter.db, plan, principal, Date.now());
  return {
    written: meter.rowsWritten,
    estimated: importWrites(result.counts, result.suppressions_added, principal.kind === "service"),
    recorded: await importWritesSince(env.DB, 0),
  };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("an import's cost in D1 rows, as the daily-writes estimate counts it", () => {
  const cases: [string, (e: string) => string, ((es: readonly string[]) => Promise<void>)?][] = [
    [
      "a new confirmed subscriber",
      (e) => `${e},subscribed,double,sendy,,2024-03-01T09:30:00Z,,,,${EVIDENCE}`,
    ],
    ["a new unsubscribed one", (e) => `${e},unsubscribed,unknown,sendy,,,,2025-01-20T08:00:00Z,,`],
    ["a new one carrying a bounce", (e) => `${e},subscribed,unknown,sendy,bounce,,,,,`],
    ["a suppression alone", (e) => `${e},none,unknown,unknown,bounce,,,,,`],
    ["a pending one confirmed", (e) => `${e},subscribed,double,sendy,,,,,,`, seedPending],
    ["a confirmed one unsubscribed", (e) => `${e},unsubscribed,unknown,sendy,,,,,,`, seedConfirmed],
    [
      "a suppression on a confirmed one",
      (e) => `${e},subscribed,unknown,sendy,complaint,,,,,`,
      seedConfirmed,
    ],
    ["a row left out", (e) => `${e},pending,unknown,unknown,,,,,,`],
    ["a row already in place", (e) => `${e},subscribed,unknown,sendy,,,,,,`, seedConfirmed],
  ];

  it("matches the estimate exactly for an import Claude commits, which also tells the publisher", async () => {
    const { written, estimated, recorded } = await costOf(
      (e) => `${e},subscribed,double,sendy,,,,,,`,
      undefined,
      { kind: "service", via: "dev" },
    );
    expect(written).toBe(estimated);
    expect(recorded).toBe(estimated);
  });

  for (const [what, line, seed] of cases) {
    it(`matches the estimate exactly for ${what}`, async () => {
      const { written, estimated, recorded } = await costOf(line, seed);
      expect(written).toBe(estimated);
      expect(recorded).toBe(estimated);
    });
  }
});
