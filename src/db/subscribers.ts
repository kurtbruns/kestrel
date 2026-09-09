/** Subscriber + suppression queries, and audience selection (I1/I2). */
import { newId, newToken } from "../lib/ids";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

export interface SubscriberRow {
  id: string;
  email: string;
  status: SubscriberStatus;
  token: string;
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

export function getByToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE token = ?").bind(token).first<SubscriberRow>();
}

/**
 * Idempotent subscribe (double opt-in). Creates a pending subscriber, or re-arms
 * a pending/unsubscribed one with a fresh token. A confirmed subscriber is a
 * no-op. Never auto-confirms — that only happens via the emailed token (I1).
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
    const token = newToken();
    await db
      .prepare(
        "UPDATE subscribers SET status = 'pending', token = ?, confirmed_at = NULL, unsubscribed_at = NULL WHERE id = ?",
      )
      .bind(token, existing.id)
      .run();
    const subscriber = (await getById(db, existing.id))!;
    return { subscriber, action: existing.status === "unsubscribed" ? "resubscribed" : "pending_resent" };
  }

  const id = newId();
  const token = newToken();
  await db
    .prepare(
      "INSERT INTO subscribers (id, email, status, token, created_at) VALUES (?, ?, 'pending', ?, ?)",
    )
    .bind(id, email, token, now)
    .run();
  return { subscriber: (await getById(db, id))!, action: "created" };
}

/** Confirm a pending subscriber by token (double opt-in). Idempotent for an
 *  already-confirmed token; refuses to confirm an unsubscribed one. */
export async function confirm(db: D1Database, token: string): Promise<SubscriberRow | null> {
  const row = await getByToken(db, token);
  if (!row) return null;
  if (row.status === "confirmed") return row;
  if (row.status !== "pending") return null;
  await db
    .prepare(
      "UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(Date.now(), row.id)
    .run();
  return getById(db, row.id);
}

/** Unsubscribe by token — immediate and idempotent (I2). */
export async function unsubscribeByToken(
  db: D1Database,
  token: string,
): Promise<SubscriberRow | null> {
  const row = await getByToken(db, token);
  if (!row) return null;
  if (row.status === "unsubscribed") return row;
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
export async function unsubscribeById(
  db: D1Database,
  id: string,
): Promise<SubscriberRow | null> {
  const row = await getById(db, id);
  if (!row) return null;
  if (row.status === "unsubscribed") return row;
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
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`);
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
    if (r.status === "pending") c.pending = r.n;
    else if (r.status === "confirmed") c.confirmed = r.n;
    else if (r.status === "unsubscribed") c.unsubscribed = r.n;
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
