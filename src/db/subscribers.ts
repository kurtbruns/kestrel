/** Subscriber + suppression queries, and audience selection (I1/I2). */
import type {
  SubscribeAction,
  Subscriber,
  SubscriberCounts,
  SubscriberStatus,
} from "../../shared/subscribers";
import { newId, newToken } from "../lib/ids";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { unwrap } from "../lib/unwrap";

// The row shapes live in shared/ so the editor reads the same definitions; the names
// here are the Worker's own.
export type { SubscribeAction, SubscriberStatus };
export type SubscriberRow = Subscriber;
export type Counts = SubscriberCounts;

export interface SuppressionRow {
  email: string;
  reason: string;
  detail: string | null;
  created_at: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function getByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<SubscriberRow>();
}

export function getById(db: D1Database, id: string): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first<SubscriberRow>();
}

/** Resolve a subscriber by their one-shot confirm token (double opt-in only). */
export function getByConfirmToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  return db
    .prepare("SELECT * FROM subscribers WHERE confirm_token = ?")
    .bind(token)
    .first<SubscriberRow>();
}

/** Resolve a subscriber by their durable unsubscribe token (the link in mail). */
export function getByUnsubToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  return db
    .prepare("SELECT * FROM subscribers WHERE unsub_token = ?")
    .bind(token)
    .first<SubscriberRow>();
}

/**
 * The subscriber row an address's confirmation is sent from: the existing one, or a new
 * pending row with no confirm token yet (none is armed until a confirmation carrying one
 * is accepted, see `armConfirmation`). `created` says whether this call made it, so a
 * refused first confirmation can take it back out (`dropUnarmed`). Never auto-confirms (I1).
 */
export async function ensureSubscriber(
  db: D1Database,
  email: string,
): Promise<{ subscriber: SubscriberRow; created: boolean }> {
  const res = await db
    .prepare(
      "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT (email) DO NOTHING",
    )
    .bind(newId(), email, newToken(), Date.now())
    .run();
  return {
    subscriber: unwrap(await getByEmail(db, email), "subscriber"),
    created: (res.meta.changes ?? 0) > 0,
  };
}

/**
 * Claim the right to send this subscriber a confirmation now: stamps `confirm_sent_at`
 * only if the last one went out at or before `quietSince`, and never for a confirmed
 * subscriber. One conditional write, so two requests racing inside the cooldown send one
 * confirmation between them. False means another went out too recently.
 */
export async function claimConfirmation(
  db: D1Database,
  id: string,
  now: number,
  quietSince: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET confirm_sent_at = ? WHERE id = ? AND status <> 'confirmed' AND (confirm_sent_at IS NULL OR confirm_sent_at <= ?)",
    )
    .bind(now, id, quietSince)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Arm the confirm token a confirmation carried once the provider took it: the address is
 * pending again, and only this newest link confirms it. Rotating only here, never before
 * the send, means a refused confirmation leaves the last link that did arrive working.
 * `unsub_token` is deliberately left untouched so the unsubscribe link already delivered
 * in past posts keeps working (I2). A subscriber who confirmed meanwhile stays confirmed.
 */
export async function armConfirmation(
  db: D1Database,
  id: string,
  token: string,
  sentAt: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE subscribers SET status = 'pending', confirm_token = ?, confirm_sent_at = ?, confirmed_at = NULL, unsubscribed_at = NULL WHERE id = ? AND status <> 'confirmed'",
    )
    .bind(token, sentAt, id)
    .run();
}

/** Undo a `claimConfirmation` whose confirmation never went out, so the cooldown counts
 *  only confirmations that were sent. A no-op if a later claim has stamped it since. */
export async function releaseConfirmation(
  db: D1Database,
  id: string,
  claimedAt: number,
  previous: number | null,
): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET confirm_sent_at = ? WHERE id = ? AND confirm_sent_at = ?")
    .bind(previous, id, claimedAt)
    .run();
}

/** Remove a row `ensureSubscriber` just made whose first confirmation was refused, so no
 *  pending subscriber is left holding a link nobody received. */
export async function dropUnarmed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      "DELETE FROM subscribers WHERE id = ? AND status = 'pending' AND confirm_token IS NULL",
    )
    .bind(id)
    .run();
}

/**
 * Confirm a pending subscriber by their confirm token (double opt-in), if the link was sent
 * after `sentAfter`, since a link is only good for a limited time. Idempotent for an
 * already-confirmed token; refuses an unsubscribed one. The one-shot property comes from
 * the `status = 'pending'` guard, so the token is left in place (not cleared) and a
 * double-click still lands on the confirmed page rather than an "invalid link".
 *
 * Confirming also lifts an `erased` suppression on the address: a person whose data was
 * erased may come back, and their own confirmation is what brings them (SPEC §7). Any
 * other suppression is the publisher's to clear and is left alone.
 */
export async function confirm(
  db: D1Database,
  token: string,
  sentAfter: number,
): Promise<SubscriberRow | null> {
  const row = await getByConfirmToken(db, token);
  if (!row) {
    return null;
  }
  if (row.status === "confirmed") {
    return row;
  }
  if (
    row.status !== "pending" ||
    row.confirm_sent_at === null ||
    row.confirm_sent_at <= sentAfter
  ) {
    return null;
  }
  await db.batch([
    db
      .prepare(
        "UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(Date.now(), row.id),
    db.prepare("DELETE FROM suppressions WHERE email = ? AND reason = ?").bind(row.email, ERASED),
  ]);
  return getById(db, row.id);
}

/** Unsubscribe by the durable unsub token — immediate and idempotent (I2). A
 *  confirm token will not resolve here, so it can never be used to unsubscribe. */
export async function unsubscribeByToken(
  db: D1Database,
  token: string,
): Promise<SubscriberRow | null> {
  const row = await getByUnsubToken(db, token);
  if (!row) {
    return null;
  }
  if (row.status === "unsubscribed") {
    return row;
  }
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return getById(db, row.id);
}

/**
 * Unsubscribe by id — the authed admin action, for a request that arrives out
 * of band. Same immediate, idempotent effect as `unsubscribeByToken` (I2);
 * returns null for an unknown id.
 */
export async function unsubscribeById(db: D1Database, id: string): Promise<SubscriberRow | null> {
  const row = await getById(db, id);
  if (!row) {
    return null;
  }
  if (row.status === "unsubscribed") {
    return row;
  }
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return getById(db, row.id);
}

/** The two orthogonal axes a roster can be narrowed by: consent `status`, and the
 *  `suppressed` overlay (a separate table — a row can be `confirmed` AND suppressed),
 *  plus an email contains-search. `suppressed`: "only" keeps suppressed addresses,
 *  "hide" drops them, absent leaves both. */
export interface SubscriberFilter {
  status?: SubscriberStatus;
  search?: string;
  suppressed?: "only" | "hide";
}

/** The sortable columns exposed by `GET /subscribers` (see `parseListParams`). */
export const SUBSCRIBER_LIST_SPEC: ListSpec = {
  columns: { joined: "created_at", confirmed: "confirmed_at", email: "email", status: "status" },
  defaultSort: "joined",
  defaultDir: "desc",
};

// Shared WHERE for the roster list and its matching count, so the page total and the
// rows on it are filtered identically. Suppression is an overlay on the address, not a
// status (a bounce or complaint can suppress an address whatever its consent state), so
// it filters by membership in the suppressions table.
function subscriberWhere(filter: SubscriberFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.suppressed === "only") {
    where.push("email IN (SELECT email FROM suppressions)");
  } else if (filter.suppressed === "hide") {
    where.push("email NOT IN (SELECT email FROM suppressions)");
  }
  // Contains-search on email. Emails are stored normalized (trimmed, lowercased), so
  // match the term the same way; escape LIKE's own wildcards so `_`/`%` in an address
  // are literal.
  const term = filter.search?.trim().toLowerCase();
  if (term) {
    where.push("email LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/** The filtered roster, one page's worth. Omit `page` for the legacy default (newest
 *  first, first 100) used by internal callers and tests. */
export async function listSubscribers(
  db: D1Database,
  filter: SubscriberFilter = {},
  page?: ListParams,
): Promise<SubscriberRow[]> {
  const { clause, binds } = subscriberWhere(filter);
  const order = page ? orderByClause(page, "id") : "ORDER BY created_at DESC, id DESC";
  const limit = page ? page.limit : 100;
  const offset = page ? page.offset : 0;
  const { results } = await db
    .prepare(`SELECT * FROM subscribers ${clause} ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<SubscriberRow>();
  return results;
}

/** How many subscribers match `filter` — the `page.total` for the roster list. */
export async function countSubscribers(
  db: D1Database,
  filter: SubscriberFilter = {},
): Promise<number> {
  const { clause, binds } = subscriberWhere(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscribers ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function counts(db: D1Database): Promise<Counts> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status")
    .all<{ status: SubscriberStatus; n: number }>();
  const c: Counts = { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 };
  for (const r of results) {
    if (r.status === "pending") {
      c.pending = r.n;
    } else if (r.status === "confirmed") {
      c.confirmed = r.n;
    } else if (r.status === "unsubscribed") {
      c.unsubscribed = r.n;
    }
  }
  const sup = await db.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{ n: number }>();
  c.suppressed = sup?.n ?? 0;
  return c;
}

/** The authoritative send audience: confirmed subscribers minus suppressions (I1). */
export async function audienceEmails(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT email FROM subscribers WHERE status = 'confirmed' AND email NOT IN (SELECT email FROM suppressions) ORDER BY email ASC",
    )
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

export async function isSuppressed(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM suppressions WHERE email = ?").bind(email).first();
  return row !== null;
}

/**
 * The suppression reason that marks an erased person (SPEC §7): the address is kept only
 * so it is never mailed by accident, and the person may still come back by subscribing
 * again. The erase action that records it is not built yet; the subscribe and confirm
 * paths already honor it, so it works the day it lands.
 */
export const ERASED = "erased";

/** Whether a suppression forbids sending this address a confirmation. Every reason does
 *  except `erased`, whose person may subscribe again and whose confirmation lifts it. */
export async function blocksConfirmation(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM suppressions WHERE email = ? AND reason <> ?")
    .bind(email, ERASED)
    .first();
  return row !== null;
}

export async function addSuppression(
  db: D1Database,
  email: string,
  reason: string,
  detail?: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(email, reason, detail ?? null, Date.now())
    .run();
}

export async function listSuppressions(db: D1Database): Promise<SuppressionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 1000")
    .all<SuppressionRow>();
  return results;
}

export async function clearSuppression(db: D1Database, email: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM suppressions WHERE email = ?").bind(email).run();
  return (res.meta.changes ?? 0) > 0;
}
