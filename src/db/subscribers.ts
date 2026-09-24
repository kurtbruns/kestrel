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
 * Claim the right to send this subscriber a confirmation now: stamps `confirm_attempt_at`
 * only if the last attempt was at or before `quietSince`, and never for a confirmed
 * subscriber. One conditional write, so two requests racing inside the cooldown send one
 * confirmation between them. False means another went out too recently. The claim leaves
 * the current token and its age alone, so an old link is not made good again by it.
 */
export async function claimConfirmation(
  db: D1Database,
  id: string,
  now: number,
  quietSince: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET confirm_attempt_at = ? WHERE id = ? AND status <> 'confirmed' AND (confirm_attempt_at IS NULL OR confirm_attempt_at <= ?)",
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
 * in past posts keeps working (I2).
 *
 * Only the claim that sent it may arm it, and only if the subscriber is still in the state
 * the claim saw: a confirm or an unsubscribe that landed during the send wins, so an
 * unsubscribe is never quietly turned back into pending (I2). False when it did not arm.
 */
export async function armConfirmation(
  db: D1Database,
  id: string,
  token: string,
  claimedAt: number,
  statusAtClaim: SubscriberStatus,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET status = 'pending', confirm_token = ?, confirm_sent_at = ?, confirmed_at = NULL, unsubscribed_at = NULL WHERE id = ? AND confirm_attempt_at = ? AND status = ?",
    )
    .bind(token, claimedAt, id, claimedAt, statusAtClaim)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Undo a `claimConfirmation` whose confirmation never went out, so the cooldown counts only
 * confirmations that were sent. A row `ensureSubscriber` made for this request (`created`)
 * is removed instead, so no pending subscriber is left holding a link nobody received.
 * Both are no-ops once a later claim has taken the row, so a racing request that is
 * sending to it keeps it.
 */
export async function releaseConfirmation(
  db: D1Database,
  id: string,
  claimedAt: number,
  previous: number | null,
  created: boolean,
): Promise<void> {
  if (created) {
    await db
      .prepare(
        "DELETE FROM subscribers WHERE id = ? AND confirm_attempt_at = ? AND status = 'pending' AND confirm_token IS NULL",
      )
      .bind(id, claimedAt)
      .run();
  }
  await db
    .prepare(
      "UPDATE subscribers SET confirm_attempt_at = ? WHERE id = ? AND confirm_attempt_at = ?",
    )
    .bind(previous, id, claimedAt)
    .run();
}

/**
 * Confirm a pending subscriber by their confirm token (double opt-in), if the link was sent
 * after `sentAfter`, since a link is only good for a limited time. Idempotent for an
 * already-confirmed token; refuses an unsubscribed one. The one-shot property comes from
 * the `status = 'pending'` guard, so the token is left in place (not cleared) and a
 * double-click still lands on the confirmed page rather than an "invalid link".
 *
 * Confirming also lifts an `erased` suppression on the address (see `ERASED`), and only
 * when this confirm is the one that took effect. Any other suppression is the publisher's
 * to clear and is left alone.
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
  const confirmedAt = Date.now();
  await db.batch([
    db
      .prepare(
        "UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending' AND confirm_token = ?",
      )
      .bind(confirmedAt, row.id, token),
    db
      .prepare(
        "DELETE FROM suppressions WHERE email = ? AND reason = ? AND EXISTS (SELECT 1 FROM subscribers WHERE id = ? AND status = 'confirmed' AND confirmed_at = ?)",
      )
      .bind(row.email, ERASED, row.id, confirmedAt),
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

/** How many addresses a send would reach now: confirmed minus suppressed, the same
 *  set `audienceEmails` lists, counted without loading it. */
export async function audienceCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM subscribers WHERE status = 'confirmed' AND email NOT IN (SELECT email FROM suppressions)",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function isSuppressed(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM suppressions WHERE email = ?").bind(email).first();
  return row !== null;
}

/**
 * The suppression reason that will mark an erased person: the address is kept only so it
 * is never mailed by accident, and the person may still come back by subscribing again,
 * their own confirmation lifting the marker. Erasure itself is not built or specified yet
 * (it lands with its SPEC §7 text); the subscribe and confirm paths already honor the
 * reason so they need no change when it does.
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
  // One suppression per address, and the first one stands, except over an `erased` marker:
  // a bounce or complaint on an erased address must still stop it being sent confirmations.
  await db
    .prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, created_at = excluded.created_at WHERE suppressions.reason = ?",
    )
    .bind(email, reason, detail ?? null, Date.now(), ERASED)
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
