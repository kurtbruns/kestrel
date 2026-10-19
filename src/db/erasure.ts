/**
 * What an erasure does to the records of past sends (SPEC §7), shared by the publisher's Erase
 * and an import whose row erases someone on the list: one random placeholder, `erased:<hex>`,
 * in place of each person's address on every delivery row, so each record still sums to its
 * audience, and the same placeholder in place of the address in a provider's words or message
 * id on those rows, in whatever case it was written, the rest of the text kept as it was.
 *
 * Every write is guarded: it touches a person's rows only once their subscriber stands erased,
 * which the batch it runs in has just made so, and leaves them alone while a send run holding its lease
 * has one of them pending or dispatched, since that run holds the real address in hand and
 * would write the provider's answer, which may name it, back onto the row. A caller checks
 * `handingOff` first and refuses for now, so the guard only catches a run that takes its lease
 * in between.
 */

import { ERASED_PREFIX } from "../../shared/subscribers";
import { newToken } from "../lib/ids";
import { jsonChunks } from "./imports";

/** SQL that holds while no send run holding its lease has the address `email` (an expression)
 *  in hand, at the time bound by the expression `now`. */
export function idleFor(email: string, now: string): string {
  return `NOT EXISTS (SELECT 1 FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.email = ${email} AND d.status IN ('pending', 'dispatched') AND s.locked_until >= ${now})`;
}

// SQL that holds once the address `email` (an expression) belongs to a subscriber erased.
const erasedNow = (email: string) =>
  `${email} IN (SELECT email FROM subscribers WHERE status = 'unsubscribed' AND unsubscribe_cause = 'erased')`;

/** How many past delivery rows still name one of `emails`. */
export async function deliveriesNaming(db: D1Database, emails: readonly string[]): Promise<number> {
  let n = 0;
  for (const chunk of jsonChunks(emails)) {
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM deliveries WHERE email IN (SELECT value FROM json_each(?))",
      )
      .bind(chunk)
      .first<{ n: number }>();
    n += row?.n ?? 0;
  }
  return n;
}

/** The addresses among `emails` that a send run holding its lease is handing off now. */
export async function handingOff(
  db: D1Database,
  emails: readonly string[],
  now: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const chunk of jsonChunks(emails)) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT d.email FROM deliveries d JOIN sends s ON s.id = d.send_id
          WHERE d.email IN (SELECT value FROM json_each(?1)) AND d.status IN ('pending', 'dispatched')
            AND s.locked_until >= ?2`,
      )
      .bind(chunk, now)
      .all<{ email: string }>();
    found.push(...results.map((r) => r.email));
  }
  return found;
}

/** `text` with every occurrence of `email` replaced by `placeholder`, matched whatever its
 *  case and leaving the rest of the text as it was; null stays null. */
function withoutAddress(text: string | null, email: string, placeholder: string): string | null {
  if (text === null) {
    return null;
  }
  const pattern = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return text.replace(pattern, placeholder);
}

/**
 * The statements that put a fresh placeholder in place of each of `emails` on its past
 * delivery rows, as of `now`, reading those rows first (through `idx_deliveries_email`).
 * `rewrite` replaces the address in the rows' provider text and must run first; `move`
 * replaces the rows' address, and its changes count the rows that now show an erased recipient.
 */
export async function forgetDeliveries(
  db: D1Database,
  emails: readonly string[],
  now: number,
): Promise<{ rewrite: D1PreparedStatement[]; move: D1PreparedStatement[] }> {
  const placeholders = new Map(emails.map((e) => [e, `${ERASED_PREFIX}${newToken(8)}`]));
  const rewritten: {
    id: number;
    error: string | null;
    event_detail: string | null;
    provider_id: string | null;
  }[] = [];
  for (const chunk of jsonChunks(emails)) {
    const { results } = await db
      .prepare(
        "SELECT id, email, error, event_detail, provider_id FROM deliveries WHERE email IN (SELECT value FROM json_each(?))",
      )
      .bind(chunk)
      .all<{
        id: number;
        email: string;
        error: string | null;
        event_detail: string | null;
        provider_id: string | null;
      }>();
    for (const r of results) {
      const placeholder = placeholders.get(r.email) ?? "";
      const next = {
        id: r.id,
        error: withoutAddress(r.error, r.email, placeholder),
        event_detail: withoutAddress(r.event_detail, r.email, placeholder),
        provider_id: withoutAddress(r.provider_id, r.email, placeholder),
      };
      if (
        next.error !== r.error ||
        next.event_detail !== r.event_detail ||
        next.provider_id !== r.provider_id
      ) {
        rewritten.push(next);
      }
    }
  }
  const field = (name: string) =>
    `${name} = (SELECT json_extract(value, '$.${name}') FROM json_each(?1) WHERE json_extract(value, '$.id') = deliveries.id)`;
  const rewrite = jsonChunks(rewritten).map((chunk) =>
    db
      .prepare(
        `UPDATE deliveries SET ${field("error")}, ${field("event_detail")}, ${field("provider_id")}
          WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))
            AND ${erasedNow("deliveries.email")} AND ${idleFor("deliveries.email", "?2")}`,
      )
      .bind(chunk, now),
  );
  const move = jsonChunks([...placeholders].map(([e, p]) => ({ e, p }))).map((chunk) =>
    db
      .prepare(
        `UPDATE deliveries
            SET email = (SELECT json_extract(value, '$.p') FROM json_each(?1) WHERE json_extract(value, '$.e') = deliveries.email)
          WHERE email IN (SELECT json_extract(value, '$.e') FROM json_each(?1))
            AND ${erasedNow("deliveries.email")} AND ${idleFor("deliveries.email", "?2")}`,
      )
      .bind(chunk, now),
  );
  return { rewrite, move };
}
