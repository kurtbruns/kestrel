/**
 * The Worker suite's shared fixtures: an empty database, confirmed readers, a frozen send,
 * a send wedged on a recipient, the sweep's tick, a send's row set by hand, a delivery for a
 * receipt to land on, and a
 * template a spec can tell apart from another. One copy, so a schema change (a new table, a new NOT NULL column)
 * is made here once rather than in every spec that seeds a reader or clears a table.
 *
 * A spec whose fixture is genuinely different (readers it needs by index, a send under
 * other config) keeps its own and names it for what it does differently.
 */

import { env } from "cloudflare:workers";
import type { Actor } from "../../shared/who_acted";
import * as posts from "../../src/db/posts";
import type { SendRow } from "../../src/db/sends";
import * as sends from "../../src/db/sends";
import { BRANDING_LOGO_KEY } from "../../src/db/settings";
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
  "send_acts",
  "sends",
  "images",
  "post_revisions",
  "posts",
  "suppressions",
  "subscribers",
  "imports",
  "settings",
];

/** Empty every table, so a test starts from the schema alone whatever ran before it. */
export async function resetDatabase(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** A person in the editor, as who acted on a change (SPEC §11). */
export function person(email: string): Actor {
  return { kind: "human", email, client: "editor" };
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

/** A send wedged on one recipient the provider never answered for (SPEC §12), its id. */
export async function wedgedSend(): Promise<string> {
  const send = await dueSend();
  await env.DB.prepare(
    "INSERT INTO deliveries (send_id, email, status, attempts, updated_at) VALUES (?, 'a@example.com', 'dispatched', 0, ?)",
  )
    .bind(send.id, Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE sends SET status = 'sending', started_at = ?, audience_resolved_at = ? WHERE id = ?",
  )
    .bind(Date.now(), Date.now(), send.id)
    .run();
  await sends.recomputeSendCounters(env.DB, send.id);
  return send.id;
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

/** Put a send's row in the given state, the way the send loop would have left it. It takes
 *  no `rev`, so what it sets is something the clock, not a write, has to surface. */
export async function setRow(
  id: string,
  fields: Record<string, number | string | null>,
): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c] ?? null), id)
    .run();
}

/** A minimal valid email template that carries `marker`, so two saves differ and a re-made
 *  send's email shows which it had. */
export const tpl = (marker: string): string =>
  `<div>{{ .Post.Body }}<p>${marker} · {{ .Publication.Name }}</p><a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></div>`;

/** The send every seeded delivery belongs to, so a spec can read its counters. */
export const SEEDED_SEND_ID = "s-receipts";

/**
 * One accepted delivery for a webhook receipt to land on, without running a send, and the
 * post and send it belongs to (the foreign keys are enforced here). The parents are shared
 * across calls; `providerId` is null for a recipient settled as sent without the provider's id.
 */
export async function seedDelivery(email: string, providerId: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-receipts', 'p-receipts', 'sent', ?, ?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, 'p-receipts', 'sent', ?, '', '', '', ?)",
    ).bind(SEEDED_SEND_ID, now, now),
    env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, provider_id, updated_at) VALUES (?, ?, 'accepted', ?, ?)",
    ).bind(SEEDED_SEND_ID, email, providerId, now),
  ]);
}

/** The outcome a receipt recorded on the delivery with this provider id, or null. The
 *  receipt lands in `event` and leaves the send loop's own `status` alone. */
export async function deliveryEvent(providerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ event: string | null }>();
  return row?.event ?? null;
}

/** The R2 keys the logo's uploads are stored under, so a spec can see what an upload wrote. */
export async function logoKeys(): Promise<string[]> {
  const { objects } = await env.MEDIA.list({ prefix: BRANDING_LOGO_KEY });
  return objects.map((o) => o.key);
}

/** Delete every logo upload. R2 outlives `resetDatabase()`, so a spec that uploads a logo
 *  clears them in its own `beforeEach`. */
export async function clearLogos(): Promise<void> {
  const keys = await logoKeys();
  if (keys.length > 0) {
    await env.MEDIA.delete(keys);
  }
}
