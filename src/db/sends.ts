/** Send queries. A `sends` row is created at schedule time and holds the frozen
 *  render (I3). State transitions use compare-and-swap (WHERE status = ...). */

export type SendStatus = "scheduled" | "sending" | "sent" | "canceled" | "failed";

export interface SendRow {
  id: string;
  post_id: string;
  status: SendStatus;
  fire_at: number;
  rendered_html: string;
  rendered_text: string;
  subject: string;
  recipient_count: number;
  locked_until: number | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/** List view — omits the large frozen bodies. */
export type SendSummary = Omit<SendRow, "rendered_html" | "rendered_text">;

export function getSend(db: D1Database, id: string): Promise<SendRow | null> {
  return db.prepare("SELECT * FROM sends WHERE id = ?").bind(id).first<SendRow>();
}

/** The post's in-flight send, if any (scheduled or sending). */
export function getActiveSendForPost(db: D1Database, postId: string): Promise<SendRow | null> {
  return db
    .prepare(
      "SELECT * FROM sends WHERE post_id = ? AND status IN ('scheduled', 'sending') ORDER BY scheduled_at DESC LIMIT 1",
    )
    .bind(postId)
    .first<SendRow>();
}

/** The most recent successfully-sent Send for a post (backs the archive page). */
export function latestSentSendForPost(db: D1Database, postId: string): Promise<SendRow | null> {
  return db
    .prepare(
      "SELECT * FROM sends WHERE post_id = ? AND status = 'sent' ORDER BY completed_at DESC LIMIT 1",
    )
    .bind(postId)
    .first<SendRow>();
}

export async function listSends(
  db: D1Database,
  opts: { status?: SendStatus; limit?: number } = {},
): Promise<SendSummary[]> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const cols =
    "id, post_id, status, fire_at, subject, recipient_count, locked_until, scheduled_at, started_at, completed_at";
  if (opts.status) {
    const { results } = await db
      .prepare(`SELECT ${cols} FROM sends WHERE status = ? ORDER BY fire_at DESC LIMIT ?`)
      .bind(opts.status, limit)
      .all<SendSummary>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT ${cols} FROM sends ORDER BY fire_at DESC LIMIT ?`)
    .bind(limit)
    .all<SendSummary>();
  return results;
}

/** Per-recipient state rollup for a send. */
export async function deliveryRollup(
  db: D1Database,
  sendId: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE send_id = ? GROUP BY status")
    .bind(sendId)
    .all<{ status: string; n: number }>();
  const rollup: Record<string, number> = {};
  for (const r of results) {
    rollup[r.status] = r.n;
  }
  return rollup;
}

// --- send-loop / sweep (M6) -------------------------------------------------

/** Scheduled sends whose fire time has arrived. */
export async function dueSends(db: D1Database, now: number): Promise<SendRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM sends WHERE status = 'scheduled' AND fire_at <= ? ORDER BY fire_at ASC")
    .bind(now)
    .all<SendRow>();
  return results;
}

/** Sends left mid-flight whose lease has expired — resume them. */
export async function resumableSends(db: D1Database, now: number): Promise<SendRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM sends WHERE status = 'sending' AND (locked_until IS NULL OR locked_until < ?) ORDER BY started_at ASC",
    )
    .bind(now)
    .all<SendRow>();
  return results;
}

/** Sends stuck in `sending` too long (for loud alerting). */
export async function stuckSends(db: D1Database, olderThan: number): Promise<SendRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM sends WHERE status = 'sending' AND started_at IS NOT NULL AND started_at < ?",
    )
    .bind(olderThan)
    .all<SendRow>();
  return results;
}

/**
 * Acquire/renew the send lease and move scheduled → sending. CAS: succeeds only
 * if the send is still scheduled/sending AND unleased (or the lease expired).
 * Returns true iff this caller now owns the send.
 */
export async function acquireLease(
  db: D1Database,
  sendId: string,
  now: number,
  leaseTtlMs: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sends
         SET status = CASE WHEN status = 'scheduled' THEN 'sending' ELSE status END,
             started_at = COALESCE(started_at, ?),
             locked_until = ?
       WHERE id = ?
         AND status IN ('scheduled', 'sending')
         AND (locked_until IS NULL OR locked_until < ?)`,
    )
    .bind(now, now + leaseTtlMs, sendId, now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function renewLease(db: D1Database, sendId: string, until: number): Promise<void> {
  await db.prepare("UPDATE sends SET locked_until = ? WHERE id = ?").bind(until, sendId).run();
}

export async function releaseLease(db: D1Database, sendId: string): Promise<void> {
  await db.prepare("UPDATE sends SET locked_until = NULL WHERE id = ?").bind(sendId).run();
}

/** Mark a send complete and its post sent (atomic). */
export async function completeSend(
  db: D1Database,
  sendId: string,
  postId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE sends SET status = 'sent', completed_at = ?, locked_until = NULL WHERE id = ? AND status = 'sending'",
      )
      .bind(now, sendId),
    db
      .prepare(
        "UPDATE posts SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'scheduled'",
      )
      .bind(now, postId),
  ]);
}

/**
 * Materialize the audience into `deliveries`, idempotently. INSERT OR IGNORE on
 * UNIQUE(send_id, email) makes re-entry a no-op, which is what lets a send resume.
 */
export async function materializeAudience(
  db: D1Database,
  sendId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO deliveries (id, send_id, email, status, attempts, updated_at)
         SELECT lower(hex(randomblob(16))), ?, s.email, 'pending', 0, ?
           FROM subscribers s
          WHERE s.status = 'confirmed'
            AND s.email NOT IN (SELECT email FROM suppressions)`,
    )
    .bind(sendId, now)
    .run();
}

export interface DeliveryWork {
  id: string;
  email: string;
  attempts: number;
  token: string | null;
  sub_status: string | null;
  suppressed: number; // 0/1
}

export async function pendingDeliveryIds(db: D1Database, sendId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT id FROM deliveries WHERE send_id = ? AND status = 'pending' ORDER BY rowid ASC",
    )
    .bind(sendId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function fetchDeliveryWork(db: D1Database, ids: string[]): Promise<DeliveryWork[]> {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT d.id AS id, d.email AS email, d.attempts AS attempts, s.token AS token,
              s.status AS sub_status, (sup.email IS NOT NULL) AS suppressed
         FROM deliveries d
         LEFT JOIN subscribers s ON s.email = d.email
         LEFT JOIN suppressions sup ON sup.email = d.email
        WHERE d.id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<DeliveryWork>();
  return results;
}

export async function setDeliveriesDispatched(
  db: D1Database,
  ids: string[],
  now: number,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(
      `UPDATE deliveries SET status = 'dispatched', updated_at = ? WHERE id IN (${placeholders})`,
    )
    .bind(now, ...ids)
    .run();
}

export async function setDeliveryAccepted(
  db: D1Database,
  id: string,
  providerId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE deliveries SET status = 'accepted', provider_id = ?, error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(providerId, now, id)
    .run();
}

export async function setDeliveryFailed(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE deliveries SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .bind(error, now, id)
    .run();
}

export async function setDeliverySkipped(db: D1Database, id: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE deliveries SET status = 'skipped', updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

export async function requeueDelivery(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE deliveries SET status = 'pending', attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(error, now, id)
    .run();
}

/** Reset a prior invocation's in-flight rows back to pending (idempotent providers only). */
export async function resetDispatchedToPending(
  db: D1Database,
  sendId: string,
  now: number,
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE deliveries SET status = 'pending', updated_at = ? WHERE send_id = ? AND status = 'dispatched'",
    )
    .bind(now, sendId)
    .run();
  return res.meta.changes ?? 0;
}

export async function countDeliveries(
  db: D1Database,
  sendId: string,
  status: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND status = ?")
    .bind(sendId, status)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- provider delivery events (M9: SES via SNS) -----------------------------

export interface DeliveryEventUpdate {
  /** SES MessageId stored on the delivery row (preferred match key). */
  providerId?: string;
  /** Recipient address (fallback match, and useful when providerId is absent). */
  email?: string;
  /** delivered | bounced | complained. */
  event: string;
  detail?: string | null;
  at: number;
}

/**
 * Record an out-of-band provider event (delivered/bounced/complained) on the
 * matching delivery row. Matches by `provider_id` when present (unique per
 * delivery), else by the most recent delivery for the email. Never touches the
 * send-loop `status` — this is a separate, later signal. Returns rows updated.
 */
export async function markDeliveryEvent(db: D1Database, u: DeliveryEventUpdate): Promise<number> {
  const detail = u.detail ?? null;
  if (u.providerId) {
    const res = await db
      .prepare(
        "UPDATE deliveries SET event = ?, event_detail = ?, event_at = ? WHERE provider_id = ?",
      )
      .bind(u.event, detail, u.at, u.providerId)
      .run();
    const n = res.meta.changes ?? 0;
    if (n > 0 || !u.email) {
      return n;
    }
    // Fall through to email match if the providerId wasn't found on any row.
  }
  if (!u.email) {
    return 0;
  }
  const res = await db
    .prepare(
      `UPDATE deliveries SET event = ?, event_detail = ?, event_at = ?
        WHERE id = (SELECT id FROM deliveries WHERE email = ? ORDER BY updated_at DESC LIMIT 1)`,
    )
    .bind(u.event, detail, u.at, u.email)
    .run();
  return res.meta.changes ?? 0;
}

/** Dispatched rows older than a threshold — ambiguous on non-idempotent providers. */
export async function staleDispatched(db: D1Database, olderThan: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'dispatched' AND updated_at < ?")
    .bind(olderThan)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
