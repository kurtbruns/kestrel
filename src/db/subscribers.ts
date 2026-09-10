/** Subscriber + suppression queries, and audience selection (I1/I2). */
import { newId, newToken } from "../lib/ids";
import { unwrap } from "../lib/unwrap";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

export interface SubscriberRow {
  id: string;
  email: string;
  status: SubscriberStatus;
  /**
   * One-shot double opt-in token. Rotated each time a pending/unsubscribed row
   * re-arms (see `subscribe`), so an old confirmation link dies on re-subscribe.
   * Nullable in the schema; always set by this module on insert and re-arm.
   */
  confirm_token: string | null;
  /**
   * Durable per-subscriber token embedded in delivered mail's unsubscribe link.
   * Minted once and NEVER rotated — not even across an unsubscribe→resubscribe
   * cycle — so one-click unsubscribe in already-sent issues never breaks (I2).
   */
  unsub_token: string;
  created_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
}

export interface SuppressionRow {
  email: string;
  reason: string;
  detail: string | null;
  created_at: number;
}

export interface Counts {
  pending: number;
  confirmed: number;
  unsubscribed: number;
  suppressed: number;
}

export type SubscribeAction = "created" | "resubscribed" | "pending_resent" | "already_confirmed";

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
 * Idempotent subscribe (double opt-in). Creates a pending subscriber, or re-arms
 * a pending/unsubscribed one. A confirmed subscriber is a no-op. Never
 * auto-confirms — that only happens via the emailed confirm token (I1).
 *
 * Re-arming rotates ONLY the one-shot `confirm_token` (so a stale confirmation
 * link can't be replayed); `unsub_token` is deliberately left untouched so the
 * unsubscribe link already delivered in past issues keeps working (I2).
 */
export async function subscribe(
  db: D1Database,
  email: string,
): Promise<{ subscriber: SubscriberRow; action: SubscribeAction }> {
  const existing = await getByEmail(db, email);
  const now = Date.now();

  if (existing) {
    if (existing.status === "confirmed") {
      return { subscriber: existing, action: "already_confirmed" };
    }
    const confirmToken = newToken();
    await db
      .prepare(
        "UPDATE subscribers SET status = 'pending', confirm_token = ?, confirmed_at = NULL, unsubscribed_at = NULL WHERE id = ?",
      )
      .bind(confirmToken, existing.id)
      .run();
    const subscriber = unwrap(await getById(db, existing.id), "subscriber");
    return {
      subscriber,
      action: existing.status === "unsubscribed" ? "resubscribed" : "pending_resent",
    };
  }

  const id = newId();
  const confirmToken = newToken();
  const unsubToken = newToken();
  await db
    .prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
    )
    .bind(id, email, confirmToken, unsubToken, now)
    .run();
  return { subscriber: unwrap(await getById(db, id), "subscriber"), action: "created" };
}

/** Confirm a pending subscriber by their confirm token (double opt-in). Idempotent
 *  for an already-confirmed token; refuses to confirm an unsubscribed one. The
 *  one-shot property comes from the `status = 'pending'` guard below, so the token
 *  is left in place (not cleared) and a double-click still lands on the confirmed
 *  page rather than an "invalid link". */
export async function confirm(db: D1Database, token: string): Promise<SubscriberRow | null> {
  const row = await getByConfirmToken(db, token);
  if (!row) {
    return null;
  }
  if (row.status === "confirmed") {
    return row;
  }
  if (row.status !== "pending") {
    return null;
  }
  await db
    .prepare(
      "UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(Date.now(), row.id)
    .run();
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

export async function listSubscribers(
  db: D1Database,
  opts: { status?: SubscriberStatus; search?: string; limit?: number } = {},
): Promise<SubscriberRow[]> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    binds.push(opts.status);
  }
  // Contains-search on email. Emails are stored normalized (trimmed, lowercased),
  // so match the term the same way; escape LIKE's own wildcards so `_`/`%` in an
  // address are literal.
  const term = opts.search?.trim().toLowerCase();
  if (term) {
    where.push("email LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM subscribers ${clause} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<SubscriberRow>();
  return results;
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
