/**
 * The Worker suite's shared fixtures: an empty database, confirmed readers, a frozen send,
 * and the sweep's tick. One copy, so a schema change (a new table, a new NOT NULL column)
 * is made here once rather than in every spec that seeds a reader or clears a table.
 *
 * A spec whose fixture is genuinely different (readers it needs by index, a send under
 * other config) keeps its own and names it for what it does differently.
 */

import { env } from "cloudflare:workers";
import * as posts from "../../src/db/posts";
import type { SendRow } from "../../src/db/sends";
import type { AppEnv } from "../../src/env";
import { getConfig } from "../../src/env";
import { freeze } from "../../src/send/schedule";
import { sweep } from "../../src/send/sweep";
import { toNextTick } from "./clock";

// Children before the rows they reference, so no delete trips a foreign key.
const TABLES = [
  "deliveries",
  "notifications",
  "send_tombstones",
  "sends",
  "images",
  "post_revisions",
  "posts",
  "suppressions",
  "subscribers",
  "settings",
];

/** Empty every table, so a test starts from the schema alone whatever ran before it. */
export async function resetDatabase(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** `n` distinct addresses: `r000@example.com`, `r001@example.com`, and on. */
export function addresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `r${String(i).padStart(3, "0")}@example.com`);
}

/**
 * Confirmed readers, one statement however many. Each reader's ids and tokens are derived
 * from their address (`id-…`, `cfm-…`, `uns-…`), so a spec can name a reader's link.
 */
export async function seedConfirmed(emails: string | readonly string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at)
     SELECT 'id-' || value, value, 'confirmed', 'cfm-' || value, 'uns-' || value, ?, ? FROM json_each(?)`,
  )
    .bind(now, now, JSON.stringify(typeof emails === "string" ? [emails] : emails))
    .run();
}

/** A post frozen into a send that fires at `fireAt`, as scheduling it does. */
export async function frozenSend(
  fireAt: number,
  { subject = "Subj", markdown = "# Hi\n\nbody" }: { subject?: string; markdown?: string } = {},
): Promise<SendRow> {
  const { post } = await posts.createPost(env.DB, { subject, markdown }, "test");
  return freeze(env, getConfig(env), post, fireAt);
}

/** A send already due: its fire time a second past, so the next sweep starts it. */
export function dueSend(opts: { subject?: string; markdown?: string } = {}): Promise<SendRow> {
  return frozenSend(Date.now() - 1000, opts);
}

/**
 * One sweep tick, the clock first moved on as the cron would (`toNextTick`). It sets the
 * system time, so the spec fakes `Date` first: `vi.useFakeTimers({ toFake: ["Date"] })` in
 * its `beforeEach`. `e` is the env to sweep with, such as one whose D1 is guarded.
 */
export async function tick(e: AppEnv = env): Promise<void> {
  await toNextTick(env.DB);
  await sweep(e);
}

/** `n` sweep ticks in a row. */
export async function ticks(n: number, e: AppEnv = env): Promise<void> {
  for (let i = 0; i < n; i++) {
    await tick(e);
  }
}
