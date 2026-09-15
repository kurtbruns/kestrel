/** Send queries. A `sends` row is created at schedule time and holds the frozen
 *  render (I3). State transitions use compare-and-swap (WHERE status = ...). */

import { type ListParams, type ListSpec, orderByClause } from "../lib/list";

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
  // Denormalized progress counters (migration 0006). A rebuildable cache of the
  // `deliveries` bucketing, maintained in the same transactions as each recipient
  // transition so `GET /sends/:id/progress` is a single-row read (SPEC §8).
  c_pending: number;
  c_in_flight: number;
  c_accepted: number;
  c_delivered: number;
  c_bounced: number;
  c_complained: number;
  c_skipped: number;
  c_failed: number;
}

/** The eight denormalized progress counters on a `sends` row. */
export interface SendCounts {
  pending: number;
  in_flight: number;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  skipped: number;
  failed: number;
}

/** Read the counter columns off a send row into the API-facing `SendCounts` shape. */
export function countsOf(send: SendRow): SendCounts {
  return {
    pending: send.c_pending,
    in_flight: send.c_in_flight,
    accepted: send.c_accepted,
    delivered: send.c_delivered,
    bounced: send.c_bounced,
    complained: send.c_complained,
    skipped: send.c_skipped,
    failed: send.c_failed,
  };
}

// --- denormalized counter maintenance (migration 0006) ----------------------
//
// The counters mirror `deliveryOutcomes`: each recipient falls in exactly one of
// eight mutually-exclusive buckets, the webhook `event` winning over the send-loop
// `status`. Every transition below moves a recipient between buckets by adjusting
// two columns by ±n, batched atomically with the `deliveries` write so the cache
// can never partially diverge from the source of truth. `recomputeSendCounters`
// rebuilds them from the aggregate (backfill, and the exactness pass at completion).

const COUNTER_COLS = [
  "c_pending",
  "c_in_flight",
  "c_accepted",
  "c_delivered",
  "c_bounced",
  "c_complained",
  "c_skipped",
  "c_failed",
] as const;
type CounterCol = (typeof COUNTER_COLS)[number];

/** The counter column a recipient contributes to, given its status and webhook event
 *  — the event wins over the status, exactly as `deliveryOutcomes` buckets. */
function bucketCol(status: string, event: string | null): CounterCol {
  if (event === "delivered") {
    return "c_delivered";
  }
  if (event === "bounced") {
    return "c_bounced";
  }
  if (event === "complained") {
    return "c_complained";
  }
  switch (status) {
    case "dispatched":
      return "c_in_flight";
    case "accepted":
      return "c_accepted";
    case "skipped":
      return "c_skipped";
    case "failed":
      return "c_failed";
    default:
      return "c_pending";
  }
}

/** A statement moving `n` recipients between two counter buckets of one send. The
 *  column names come from the fixed `CounterCol` union, never user input. */
function counterMove(
  db: D1Database,
  sendId: string,
  from: CounterCol,
  to: CounterCol,
  n: number,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE sends SET ${from} = ${from} - ?, ${to} = ${to} + ? WHERE id = ?`)
    .bind(n, n, sendId);
}

/**
 * Rebuild the eight counters from `deliveries` (the source of truth) for one send,
 * bucketed exactly as `deliveryOutcomes`. The counters are a cache, so this both
 * backfills (migration 0006) and runs as the exactness pass when a send completes,
 * guaranteeing the permanent record's numbers equal the aggregate.
 */
export function recomputeSendCountersStmt(db: D1Database, sendId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sends SET
         c_pending    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'pending'),
         c_in_flight  = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'dispatched'),
         c_accepted   = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'accepted'),
         c_delivered  = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'delivered'),
         c_bounced    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'bounced'),
         c_complained = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'complained'),
         c_skipped    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'skipped'),
         c_failed     = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'failed')
       WHERE id = ?`,
    )
    .bind(sendId);
}

export async function recomputeSendCounters(db: D1Database, sendId: string): Promise<void> {
  await recomputeSendCountersStmt(db, sendId).run();
}

/** Whether the send still has a recipient that has been retried (attempts > 0) and is
 *  not yet terminal — the signal that separates the `retrying` phase from a clean
 *  `progressing` one. An indexed EXISTS probe (send_id, status), so it stays cheap
 *  even on a large audience and keeps `/progress` off a full aggregate. */
export async function hasActiveRetries(db: D1Database, sendId: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS x FROM deliveries WHERE send_id = ? AND status IN ('pending', 'dispatched') AND attempts > 0 LIMIT 1",
    )
    .bind(sendId)
    .first<{ x: number }>();
  return row != null;
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

/** One published issue for the public archive index (§5): the frozen subject and
 *  the slug that addresses its archive page. */
export interface PublishedIssue {
  slug: string;
  subject: string;
  sent_at: number;
}

/** Sent issues for the public archive index, newest first — one row per post
 *  (a re-send collapses to its latest). SQLite carries the bare `subject`/`slug`
 *  from the MAX(completed_at) row of each group. */
export async function listPublishedIssues(db: D1Database, limit = 200): Promise<PublishedIssue[]> {
  const { results } = await db
    .prepare(
      `SELECT p.slug AS slug, s.subject AS subject, MAX(s.completed_at) AS sent_at
         FROM sends s JOIN posts p ON p.id = s.post_id
         WHERE s.status = 'sent'
         GROUP BY s.post_id
         ORDER BY sent_at DESC
         LIMIT ?`,
    )
    .bind(Math.min(limit, 1000))
    .all<PublishedIssue>();
  return results;
}

/** Narrow the send list by `status` and a subject contains-search. */
export interface SendFilter {
  status?: SendStatus;
  search?: string;
}

/** The sortable columns exposed by `GET /sends` (see `parseListParams`). */
export const SEND_LIST_SPEC: ListSpec = {
  columns: {
    fire: "fire_at",
    status: "status",
    recipients: "recipient_count",
    subject: "subject",
  },
  defaultSort: "fire",
  defaultDir: "desc",
};

// The list projection deliberately omits the large frozen bodies (rendered_html/_text)
// but carries the denormalized counters, so a list row is enough for the Sent-page
// active row and the dashboard active-send widget without a second per-send read.
const SEND_LIST_COLS =
  "id, post_id, status, fire_at, subject, recipient_count, locked_until, scheduled_at, started_at, completed_at, c_pending, c_in_flight, c_accepted, c_delivered, c_bounced, c_complained, c_skipped, c_failed";

function sendWhere(filter: SendFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  const term = filter.search?.trim().toLowerCase();
  if (term) {
    where.push("LOWER(subject) LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/** One page of sends (frozen bodies omitted). Omit `page` for the legacy default
 *  (newest first, first 200) used by internal callers and tests. */
export async function listSends(
  db: D1Database,
  filter: SendFilter = {},
  page?: ListParams,
): Promise<SendSummary[]> {
  const { clause, binds } = sendWhere(filter);
  const order = page ? orderByClause(page, "id") : "ORDER BY fire_at DESC, id DESC";
  const limit = page ? page.limit : 200;
  const offset = page ? page.offset : 0;
  const { results } = await db
    .prepare(`SELECT ${SEND_LIST_COLS} FROM sends ${clause} ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<SendSummary>();
  return results;
}

/** How many sends match `filter` — the `page.total` for the send list. */
export async function countSends(db: D1Database, filter: SendFilter = {}): Promise<number> {
  const { clause, binds } = sendWhere(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM sends ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

/**
 * How a send went, as mutually-exclusive buckets that sum to the frozen audience —
 * the numbers behind the sent record view (SPEC §8). A `deliveries` row carries two
 * orthogonal facts: the send-loop `status` (did the provider accept the hand-off) and
 * the later webhook `event` (delivered / bounced / complained). This bucketing reads
 * the terminal delivery `event` first, then falls back to `status` for rows no event
 * has landed on yet, so every recipient lands in exactly one bucket and the totals
 * reconcile. It reflects the record read-only (I3) — it decides nothing and mails no one.
 */
export interface DeliveryOutcomes {
  recipients: number;
  delivered: number;
  bounced: number;
  complained: number;
  /** Transport-level send failure (never left; does not itself suppress). */
  failed: number;
  /** Excluded at send time (unsubscribed or suppressed after the audience froze). */
  skipped: number;
  /** Accepted by the provider, with no delivery event yet (a provider may emit none). */
  accepted: number;
  /** Still pending or dispatched — nonzero only while sending or wedged (§11). */
  in_flight: number;
}

export async function deliveryOutcomes(db: D1Database, sendId: string): Promise<DeliveryOutcomes> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS recipients,
         COALESCE(SUM(event = 'delivered'), 0) AS delivered,
         COALESCE(SUM(event = 'bounced'), 0) AS bounced,
         COALESCE(SUM(event = 'complained'), 0) AS complained,
         COALESCE(SUM(event IS NULL AND status = 'failed'), 0) AS failed,
         COALESCE(SUM(event IS NULL AND status = 'skipped'), 0) AS skipped,
         COALESCE(SUM(event IS NULL AND status = 'accepted'), 0) AS accepted,
         COALESCE(SUM(event IS NULL AND status IN ('pending', 'dispatched')), 0) AS in_flight
       FROM deliveries WHERE send_id = ?`,
    )
    .bind(sendId)
    .first<DeliveryOutcomes>();
  return (
    row ?? {
      recipients: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      skipped: 0,
      accepted: 0,
      in_flight: 0,
    }
  );
}

/** One recipient's row for the sent record's CSV export — the send-loop `status`
 *  and the later webhook `event`, the two orthogonal facts (see `deliveryOutcomes`). */
export interface DeliveryExportRow {
  email: string;
  status: string;
  event: string | null;
  event_at: number | null;
  error: string | null;
}

/** Every recipient of a send, address-ordered, for the record view's CSV export.
 *  Read-only over the frozen delivery record (I3). */
export async function listDeliveries(db: D1Database, sendId: string): Promise<DeliveryExportRow[]> {
  const { results } = await db
    .prepare(
      "SELECT email, status, event, event_at, error FROM deliveries WHERE send_id = ? ORDER BY email ASC",
    )
    .bind(sendId)
    .all<DeliveryExportRow>();
  return results;
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
    // Exactness pass: rebuild the counters from the aggregate as the record becomes
    // permanent, so its numbers equal `deliveries` regardless of any live-delta drift.
    // Delivery events keep arriving after this and update the counters on their own.
    recomputeSendCountersStmt(db, sendId),
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
  // Insert the audience, then set c_pending to the true count of queued rows — an
  // absolute set (not a delta) so it is correct on the first run and idempotent on a
  // resume, and atomic with the insert so the counter can't diverge from a crash mid-way.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (id, send_id, email, status, attempts, updated_at)
           SELECT lower(hex(randomblob(16))), ?, s.email, 'pending', 0, ?
             FROM subscribers s
            WHERE s.status = 'confirmed'
              AND s.email NOT IN (SELECT email FROM suppressions)`,
      )
      .bind(sendId, now),
    db
      .prepare(
        "UPDATE sends SET c_pending = (SELECT COUNT(*) FROM deliveries WHERE send_id = sends.id AND status = 'pending' AND event IS NULL) WHERE id = ?",
      )
      .bind(sendId),
  ]);
}

export interface DeliveryWork {
  id: string;
  email: string;
  attempts: number;
  unsub_token: string | null;
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
      `SELECT d.id AS id, d.email AS email, d.attempts AS attempts, s.unsub_token AS unsub_token,
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

/** Move a chunk of `pending` rows to `dispatched` (the intent-before-network step). */
export async function setDeliveriesDispatched(
  db: D1Database,
  sendId: string,
  ids: string[],
  now: number,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  await db.batch([
    db
      .prepare(
        `UPDATE deliveries SET status = 'dispatched', updated_at = ? WHERE id IN (${placeholders})`,
      )
      .bind(now, ...ids),
    counterMove(db, sendId, "c_pending", "c_in_flight", ids.length),
  ]);
}

export async function setDeliveryAccepted(
  db: D1Database,
  sendId: string,
  id: string,
  providerId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE deliveries SET status = 'accepted', provider_id = ?, error = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(providerId, now, id),
    counterMove(db, sendId, "c_in_flight", "c_accepted", 1),
  ]);
}

/**
 * Mark a recipient failed. `from` names the bucket it is leaving — `pending` for a
 * recipient failed before dispatch (max-attempts / suppressed at claim), `dispatched`
 * for a non-retryable rejection after the network call — so the counter move is exact.
 */
export async function setDeliveryFailed(
  db: D1Database,
  sendId: string,
  id: string,
  error: string,
  now: number,
  from: "pending" | "dispatched",
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE deliveries SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(error, now, id),
    counterMove(db, sendId, from === "pending" ? "c_pending" : "c_in_flight", "c_failed", 1),
  ]);
}

/** Skip a `pending` recipient excluded at claim time (unsubscribed / suppressed, I2). */
export async function setDeliverySkipped(
  db: D1Database,
  sendId: string,
  id: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE deliveries SET status = 'skipped', updated_at = ? WHERE id = ?")
      .bind(now, id),
    counterMove(db, sendId, "c_pending", "c_skipped", 1),
  ]);
}

/** Requeue a `dispatched` recipient to `pending` for the next tick (retryable outcome). */
export async function requeueDelivery(
  db: D1Database,
  sendId: string,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE deliveries SET status = 'pending', attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(error, now, id),
    counterMove(db, sendId, "c_in_flight", "c_pending", 1),
  ]);
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
  const n = res.meta.changes ?? 0;
  if (n > 0) {
    await counterMove(db, sendId, "c_in_flight", "c_pending", n).run();
  }
  return n;
}

/**
 * Operator adjudication of a wedged send's ambiguous rows (SPEC §11). Moves every
 * still-`dispatched` row of a send to a terminal state the operator chose —
 * `failed` (assume the batch never left) or `accepted` (assume it did) — stamping
 * the reason into `error` as an inspectable audit trail. It touches ONLY
 * `dispatched` rows, so an already-`accepted` recipient is never disturbed, and it
 * never re-mails anyone (nothing here calls the provider). Returns rows resolved.
 */
export async function resolveDispatched(
  db: D1Database,
  sendId: string,
  outcome: "failed" | "accepted",
  note: string,
  now: number,
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE deliveries SET status = ?, error = ?, updated_at = ? WHERE send_id = ? AND status = 'dispatched'",
    )
    .bind(outcome, note, now, sendId)
    .run();
  const n = res.meta.changes ?? 0;
  if (n > 0) {
    // A dispatched row carries no webhook event yet, so it leaves c_in_flight for the
    // adjudicated terminal bucket.
    await counterMove(
      db,
      sendId,
      "c_in_flight",
      outcome === "failed" ? "c_failed" : "c_accepted",
      n,
    ).run();
  }
  return n;
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

export interface DeliveryEventResult {
  /** Rows updated (0 or 1). */
  changes: number;
  /**
   * The affected row's recipient address, or null if nothing matched. Lets a
   * caller that received an event carrying only a `provider_id` (no `email`)
   * still recover the address for a suppression decision — the suppression
   * guarantee (I1) must not depend on the provider echoing the recipient back.
   */
  email: string | null;
}

/**
 * Record an out-of-band provider event (delivered/bounced/complained) on the
 * matching delivery row. Matches by `provider_id` when present (unique per
 * delivery), else by the most recent delivery for the email. Never touches the
 * send-loop `status` — this is a separate, later signal. Returns the rows
 * updated and the affected row's address.
 */
export async function markDeliveryEvent(
  db: D1Database,
  u: DeliveryEventUpdate,
): Promise<DeliveryEventResult> {
  const detail = u.detail ?? null;
  // Locate the target row first so the counter delta knows the bucket it is leaving
  // (an event can land on an `accepted` row, or overwrite an earlier event). Matching
  // is by `provider_id` (unique per delivery) then by the recipient's most recent row.
  let row: {
    id: string;
    send_id: string;
    email: string;
    status: string;
    event: string | null;
  } | null = null;
  if (u.providerId) {
    row = await db
      .prepare(
        "SELECT id, send_id, email, status, event FROM deliveries WHERE provider_id = ? LIMIT 1",
      )
      .bind(u.providerId)
      .first();
  }
  if (!row && u.email) {
    row = await db
      .prepare(
        "SELECT id, send_id, email, status, event FROM deliveries WHERE email = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(u.email)
      .first();
  }
  if (!row) {
    return { changes: 0, email: null };
  }

  const fromCol = bucketCol(row.status, row.event);
  const toCol = bucketCol(row.status, u.event);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE deliveries SET event = ?, event_detail = ?, event_at = ? WHERE id = ?")
      .bind(u.event, detail, u.at, row.id),
  ];
  if (fromCol !== toCol) {
    stmts.push(counterMove(db, row.send_id, fromCol, toCol, 1));
  }
  await db.batch(stmts);
  return { changes: 1, email: row.email };
}

/** An accepted recipient with no delivery event yet — a candidate for the dev send
 *  simulation to fabricate a delayed delivered / bounced / complained webhook against
 *  (see src/providers/simulate.ts). Read-only; never used by the real send path. */
export interface AcceptedAwaitingEvent {
  send_id: string;
  email: string;
  provider_id: string | null;
  updated_at: number;
}

/** Accepted-but-unconfirmed deliveries of in-flight or recently-sent sends, oldest
 *  first, for the dev simulation's delayed synthetic webhooks. Bounded by `limit`. */
export async function acceptedAwaitingEvent(
  db: D1Database,
  limit: number,
): Promise<AcceptedAwaitingEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT d.send_id AS send_id, d.email AS email, d.provider_id AS provider_id, d.updated_at AS updated_at
         FROM deliveries d JOIN sends s ON s.id = d.send_id
        WHERE d.status = 'accepted' AND d.event IS NULL
          AND s.status IN ('sending', 'sent')
        ORDER BY d.updated_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<AcceptedAwaitingEvent>();
  return results;
}

/** Dispatched rows older than a threshold — ambiguous on non-idempotent providers. */
export async function staleDispatched(db: D1Database, olderThan: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'dispatched' AND updated_at < ?")
    .bind(olderThan)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
