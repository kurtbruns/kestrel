/** Send queries. A `sends` row is created at schedule time and holds the frozen
 *  render (I3). State transitions use compare-and-swap (WHERE status = ...). Every write
 *  to a send stamps its `rev` (see `NEXT_REV`). */

import { normalizeEmail } from "../../shared/email";
import type {
  DeliveryOutcomes,
  DeliveryRecord,
  DeliveryView,
  HaltCause,
  HaltReason,
  Send,
  SendCounts,
  SendStatus,
  SendSummary,
} from "../../shared/sends";
import type { ScheduledSendRef } from "../../shared/settings";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { unwrap } from "../lib/unwrap";

// The row shapes live in shared/ so the editor reads the same definitions; the names
// here are the Worker's own.
export type { SendStatus };
export type SendRow = Send;

export type { SendCounts };

/** Read the counter columns off a send row into the API-facing `SendCounts` shape. */
export function countsOf(send: SendSummary): SendCounts {
  return {
    pending: send.c_pending,
    in_flight: send.c_in_flight,
    accepted: send.c_accepted,
    delivered: send.c_delivered,
    bounced: send.c_bounced,
    complained: send.c_complained,
    skipped: send.c_skipped,
    unsent: send.c_unsent,
  };
}

// --- the change sequence (`sends.rev`, SPEC §8) -----------------------------------
//
// Every write that changes what a reader can see of a send sets its `rev` to NEXT_REV,
// inside the same statement, so a client holding the sequence value it last read can ask
// for every send that changed after it, across sends, whichever client made the change.
// The sequence is the largest `rev` any send holds, or the floor, whichever is higher. A
// delete takes a number of its own by raising the floor past the sequence
// (`raiseRevFloorStmt`), so a number is never handed out twice even when the send that
// held the largest one goes, and a floor above a client's cursor tells it that something
// it listed may be gone. Rows one statement stamps share its number, as rows one read
// sees are one snapshot. The one write that does not stamp is a lease
// renewal (`renewLease`): it changes nothing a reader sees. `test/send_rev.spec.ts`
// fails if a write to `sends` anywhere under src/ leaves NEXT_REV out, or a delete skips
// the floor.

/** The sequence value now: every change so far is at or below it. Each side falls back
 *  to 0, since SQLite's two-argument MAX is null if either is, and a null here would fail
 *  every write to a send. */
const CURRENT_REV =
  "MAX(COALESCE((SELECT MAX(rev) FROM sends), 0), COALESCE((SELECT value FROM send_rev_floor WHERE id = 1), 0))";

/** The number a write to a send takes: above every change before it. */
export const NEXT_REV = `(${CURRENT_REV} + 1)`;

/** Run before deleting sends, in the same batch: the delete takes the next number as
 *  the floor, so the sequence never falls back when the send that held its largest number
 *  goes, and the removal itself is a change a cursor can be past or not. */
export function raiseRevFloorStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE send_rev_floor SET value = ${NEXT_REV} WHERE id = 1`);
}

// --- denormalized counter maintenance (`sends.c_*`) --------------------------
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
  "c_unsent",
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
    case "unsent":
      return "c_unsent";
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
    .prepare(
      `UPDATE sends SET ${from} = ${from} - ?, ${to} = ${to} + ?, rev = ${NEXT_REV} WHERE id = ?`,
    )
    .bind(n, n, sendId);
}

/**
 * Rebuild the eight counters from `deliveries` (the source of truth) for one send,
 * bucketed exactly as `deliveryOutcomes`. The counters are a cache, so this both
 * backfills the counters and runs as the exactness pass when a send completes,
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
         c_unsent     = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'unsent'),
         rev          = ${NEXT_REV}
       WHERE id = ?`,
    )
    .bind(sendId);
}

export async function recomputeSendCounters(db: D1Database, sendId: string): Promise<void> {
  await recomputeSendCountersStmt(db, sendId).run();
}

/** A recipient of the send named by `sendIdExpr` that has been retried (attempts > 0)
 *  and is not yet terminal: the signal that separates the `retrying` phase from a clean
 *  `progressing` one. An EXISTS over the (send_id, status) index, so it stays cheap even
 *  on a large audience. `sendIdExpr` is fixed SQL (a `?` or a column), never user input. */
function activeRetriesSql(sendIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = ${sendIdExpr} AND d.status IN ('pending', 'dispatched') AND d.attempts > 0)`;
}

/** Whether the send still has a retried recipient in flight (`activeRetriesSql`): one
 *  probe, which keeps `/progress` off a full aggregate. */
export async function hasActiveRetries(db: D1Database, sendId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${activeRetriesSql("?")} AS x`)
    .bind(sendId)
    .first<{ x: number }>();
  return row?.x === 1;
}

export type { SendSummary };

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

/** One published post for the public archive index (§5): the frozen subject and
 *  the slug that addresses its archive page. */
export interface PublishedPost {
  slug: string;
  subject: string;
  sent_at: number;
}

/** Sent posts for the public archive index, newest first — one row per post
 *  (a re-send collapses to its latest). SQLite carries the bare `subject`/`slug`
 *  from the MAX(completed_at) row of each group. */
export async function listPublishedPosts(db: D1Database, limit = 200): Promise<PublishedPost[]> {
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
    .all<PublishedPost>();
  return results;
}

/** Narrow the send list by `status`, a subject contains-search, and — `failures: "only"` —
 *  to sends with any bounce, complaint, or unsent recipient on their counters. */
export interface SendFilter {
  status?: SendStatus;
  search?: string;
  failures?: "only";
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
  "id, post_id, status, fire_at, subject, recipient_count, locked_until, scheduled_at, started_at, completed_at, audience_resolved_at, remade_at, halt_reason, halt_cause, halt_error, halted_at, halt_retries, halt_retry_at, c_pending, c_in_flight, c_accepted, c_delivered, c_bounced, c_complained, c_skipped, c_unsent, rev";

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
  // A filter rather than a sortable "delivery failures" column: the Sent list keeps its newest-first
  // order, and no severity weighting is implied (a summed sort would rank 25 retried
  // unsent recipients above one spam complaint). Reads the denormalized counters, so it
  // costs the same as any other WHERE (SPEC §8).
  if (filter.failures === "only") {
    where.push("(c_bounced + c_complained + c_unsent) > 0");
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

/** A `GET /sends` row as read: the list projection plus the retry probe, folded in so a
 *  page of rows is one statement rather than a probe per row. */
export type SendListRow = SendSummary & { has_retries: 0 | 1 };

/** One page of the send list, how many sends match, and the change sequence the page
 *  was read at (SPEC §8). */
export interface SendListPage {
  rows: SendListRow[];
  total: number;
  seq: number;
}

/**
 * One page of sends for `GET /sends`, read in one batch so the page, its total, and the
 * change sequence are one snapshot: a change either shows in the rows or lands after
 * `seq`, never neither. Only a `sending` send's retry probe can decide its phase, so the
 * CASE skips the probe for every other row (an AND would still run it: SQLite evaluates
 * both sides of one in a result column).
 */
export async function listSendsPage(
  db: D1Database,
  filter: SendFilter,
  page: ListParams,
): Promise<SendListPage> {
  const { clause, binds } = sendWhere(filter);
  const [seq, count, list] = await db.batch([
    db.prepare(`SELECT ${CURRENT_REV} AS seq`),
    db.prepare(`SELECT COUNT(*) AS n FROM sends ${clause}`).bind(...binds),
    db
      .prepare(
        `SELECT ${SEND_LIST_COLS},
                CASE WHEN status = 'sending' THEN ${activeRetriesSql("sends.id")} ELSE 0 END AS has_retries
           FROM sends ${clause} ${orderByClause(page, "id")} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, page.limit, page.offset),
  ]);
  return {
    rows: (list?.results ?? []) as SendListRow[],
    total: (count?.results[0] as { n: number } | undefined)?.n ?? 0,
    seq: unwrap((seq?.results[0] as { seq: number } | undefined)?.seq, "the send sequence"),
  };
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
 * How a send went, as mutually-exclusive buckets that sum to the audience at fire —
 * the numbers behind the sent record view (SPEC §8). A `deliveries` row carries two
 * orthogonal facts: the send-loop `status` (did the provider accept the hand-off) and
 * the later webhook `event` (delivered / bounced / complained). This bucketing reads
 * the terminal delivery `event` first, then falls back to `status` for rows no event
 * has landed on yet, so every recipient lands in exactly one bucket and the totals
 * reconcile. It reflects the record read-only (I3) — it decides nothing and mails no one.
 */
export type { DeliveryOutcomes };

export async function deliveryOutcomes(db: D1Database, sendId: string): Promise<DeliveryOutcomes> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS recipients,
         COALESCE(SUM(event = 'delivered'), 0) AS delivered,
         COALESCE(SUM(event = 'bounced'), 0) AS bounced,
         COALESCE(SUM(event = 'complained'), 0) AS complained,
         COALESCE(SUM(event IS NULL AND status = 'unsent'), 0) AS unsent,
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
      unsent: 0,
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

// --- per-recipient record rows (in-app, paginated) --------------------------
//
// The record view (SPEC §8) shows the delivery rows inside the app, not just as the
// CSV export. It reads `deliveries` DIRECTLY — the source of truth — never the `c_*`
// counters (those are the aggregate cache for the cheap poll). A `view` narrows the
// rows to a mutually-exclusive outcome bucket (or the `failures` group / `all`), using
// the SAME event-wins-over-status bucketing as `deliveryOutcomes` so a filtered list
// reconciles to its tile. Since it isn't polled, this read can be heavier than
// `/progress`. Every field is a fact of the send's own delivery rows (including the
// frozen `bounce_kind`), so the record never drifts with global suppression state.

/** The recognized `view` values: the three UI toggles (`failures` default / `delivered`
 *  / `all`) plus the individual outcome buckets, so a caller can filter to any one. */
export const DELIVERY_VIEWS = [
  "failures",
  "delivered",
  "all",
  "bounced",
  "complained",
  "unsent",
  "skipped",
  "accepted",
  "in_flight",
] as const satisfies readonly DeliveryView[];
export type { DeliveryView };

/** The sortable columns exposed by `GET /sends/:id/deliveries`. Default `email` asc
 *  matches the CSV order, so the in-app list and the export read the same. */
export const DELIVERY_LIST_SPEC: ListSpec = {
  columns: {
    email: "d.email",
    status: "d.status",
    event: "d.event",
    updated: "d.updated_at",
  },
  defaultSort: "email",
  defaultDir: "asc",
};

/** One recipient's row for the in-app record. Carries the two orthogonal facts (the
 *  send-loop `status` and the later webhook `event`, see `deliveryOutcomes`), the
 *  provider detail/error, and — for a bounce — the frozen soft/hard `bounce_kind`
 *  recorded when the event landed (SPEC §8). The split is a fact of THIS send, so it
 *  never drifts with the global, clearable `suppressions` table. */
export type DeliveryRecordRow = DeliveryRecord;

/** The WHERE fragment for one `view`, bucketed exactly as `deliveryOutcomes` (the
 *  webhook `event` winning over the send-loop `status`). Empty string = `all`. */
function deliveryViewClause(view: DeliveryView): string {
  switch (view) {
    case "delivered":
      return "d.event = 'delivered'";
    case "bounced":
      return "d.event = 'bounced'";
    case "complained":
      return "d.event = 'complained'";
    case "unsent":
      return "d.event IS NULL AND d.status = 'unsent'";
    case "skipped":
      return "d.event IS NULL AND d.status = 'skipped'";
    case "accepted":
      return "d.event IS NULL AND d.status = 'accepted'";
    case "in_flight":
      return "d.event IS NULL AND d.status IN ('pending', 'dispatched')";
    case "failures":
      // Bounced / complained / unsent — the rows that went wrong, front-and-center.
      return "(d.event IN ('bounced', 'complained')) OR (d.event IS NULL AND d.status = 'unsent')";
    default:
      return "";
  }
}

function deliveryListWhere(
  sendId: string,
  view: DeliveryView,
  search?: string,
): { clause: string; binds: unknown[] } {
  const where = ["d.send_id = ?"];
  const binds: unknown[] = [sendId];
  const viewClause = deliveryViewClause(view);
  if (viewClause) {
    where.push(`(${viewClause})`);
  }
  const term = search?.trim().toLowerCase();
  if (term) {
    where.push("LOWER(d.email) LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { clause: `WHERE ${where.join(" AND ")}`, binds };
}

/** One page of a send's per-recipient rows for the in-app record, filtered by `view`
 *  and an optional email search. Read-only over the frozen delivery record (I3). */
export async function listDeliveriesPage(
  db: D1Database,
  sendId: string,
  view: DeliveryView,
  page: ListParams,
  search?: string,
): Promise<DeliveryRecordRow[]> {
  const { clause, binds } = deliveryListWhere(sendId, view, search);
  // Address is UNIQUE per send, so it is the stable tiebreak for offset paging.
  const order = orderByClause(page, "d.email");
  const { results } = await db
    .prepare(
      `SELECT d.email AS email, d.status AS status, d.event AS event, d.event_detail AS event_detail,
              d.event_at AS event_at, d.error AS error, d.attempts AS attempts,
              d.bounce_kind AS bounce_kind
         FROM deliveries d
         ${clause} ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...binds, page.limit, page.offset)
    .all<DeliveryRecordRow>();
  return results;
}

/** How many recipients match `view` (+ search) — the `page.total` for the record list. */
export async function countDeliveriesFiltered(
  db: D1Database,
  sendId: string,
  view: DeliveryView,
  search?: string,
): Promise<number> {
  const { clause, binds } = deliveryListWhere(sendId, view, search);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM deliveries d ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- the freeze ------------------------------------------------------------------

/** The frozen render a freeze (or a re-make) writes onto a send: the one render
 *  path's output, as the three columns the send loop reads back. */
export interface FrozenRender {
  rendered_html: string;
  rendered_text: string;
  subject: string;
}

/** The predicate that ties a settings-dependent write to the settings the writer
 *  read: the row's `updated_at` (0 when there is no row yet) must still equal
 *  `version`. The freeze puts it on its insert so a schedule that rendered with a
 *  template the publisher has since replaced can never land (SPEC §6, §9). */
export function settingsVersionIs(version: number): { sql: string; binds: unknown[] } {
  return {
    sql: "COALESCE((SELECT updated_at FROM settings WHERE id = 1), 0) = ?",
    binds: [version],
  };
}

/**
 * Insert a `scheduled` send holding a frozen render, guarded on the settings version
 * the render used (`settingsVersionIs`): `meta.changes === 0` means the template or
 * identity changed between the read and this write, and the caller re-renders. The
 * partial unique index on active sends still fails the insert for a second active
 * send, which the caller maps to a conflict.
 */
export function insertScheduledSendStmt(
  db: D1Database,
  send: FrozenRender & { id: string; post_id: string; fire_at: number; recipient_count: number },
  now: number,
  settingsVersion: number,
): D1PreparedStatement {
  const guard = settingsVersionIs(settingsVersion);
  return db
    .prepare(
      `INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, scheduled_at, rev)
       SELECT ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ${NEXT_REV}
        WHERE ${guard.sql}`,
    )
    .bind(
      send.id,
      send.post_id,
      send.fire_at,
      send.rendered_html,
      send.rendered_text,
      send.subject,
      send.recipient_count,
      now,
      ...guard.binds,
    );
}

/** Move a scheduled send's fire time, nothing else. A CAS on `status = 'scheduled'`:
 *  `meta.changes === 0` means the send has left the review window (or never existed). */
export function rescheduleStmt(
  db: D1Database,
  sendId: string,
  fireAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sends SET fire_at = ?, rev = ${NEXT_REV} WHERE id = ? AND status = 'scheduled'`,
    )
    .bind(fireAt, sendId);
}

/** Cancel a scheduled send. The same CAS as `rescheduleStmt`: a send that has begun
 *  sending, or is already sent or canceled, changes zero rows. */
export function cancelStmt(db: D1Database, sendId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sends SET status = 'canceled', completed_at = ?, rev = ${NEXT_REV} WHERE id = ? AND status = 'scheduled'`,
    )
    .bind(now, sendId);
}

/** The predicate a post unlock carries when it runs in a batch after `cancelStmt`: the
 *  post has no active send left. When the cancel's CAS changed nothing because the send
 *  is still active, the unlock changes nothing too; a failure in either rolls back both. */
export function noActiveSendFor(postId: string): { sql: string; binds: unknown[] } {
  return {
    sql: "NOT EXISTS (SELECT 1 FROM sends WHERE post_id = ? AND status IN ('scheduled', 'sending'))",
    binds: [postId],
  };
}

// --- the re-make (SPEC §6, §9) ---------------------------------------------------

/** A scheduled send as the settings surface lists it: what a template or identity
 *  change would re-make, and what the client acknowledges by id. */
export type { ScheduledSendRef };

/** Every `scheduled` send, soonest first: the set "in use" by the template and the
 *  identity. A `sending` send is past the window and a `sent` one is the record;
 *  neither is listed, counted, or ever re-made. */
export async function listScheduledSends(db: D1Database): Promise<ScheduledSendRef[]> {
  const { results } = await db
    .prepare(
      "SELECT id, post_id, subject, fire_at, remade_at FROM sends WHERE status = 'scheduled' ORDER BY fire_at ASC, id ASC",
    )
    .all<ScheduledSendRef>();
  return results;
}

/**
 * The predicate every statement of a re-make batch carries, so the batch lands whole
 * or not at all against three things that can move between the read and the write:
 * the settings version the render used (`settingsVersionIs`), a scheduled send inside
 * the minimum lead (`minFireAt` is now + the lead), and a scheduled send the client
 * did not acknowledge (`ackIds`), such as one scheduled in the gap. Nothing here is
 * user text: the ids are bound, the rest is fixed SQL.
 */
export function remakeGuard(
  settingsVersion: number,
  minFireAt: number,
  ackIds: string[],
): { sql: string; binds: unknown[] } {
  const version = settingsVersionIs(settingsVersion);
  // The acknowledged ids travel as one JSON-array parameter, so the statement's bind
  // count stays fixed however many sends are scheduled (D1 caps a statement at 100).
  return {
    sql: `${version.sql} AND NOT EXISTS (SELECT 1 FROM sends WHERE status = 'scheduled' AND fire_at < ?)
      AND NOT EXISTS (SELECT 1 FROM sends WHERE status = 'scheduled' AND id NOT IN (SELECT value FROM json_each(?)))`,
    binds: [...version.binds, minFireAt, JSON.stringify(ackIds)],
  };
}

/**
 * Re-freeze one scheduled send in place: the rendered columns and `remade_at`, nothing
 * else (the fire time, the window's anchor, and the audience snapshot stay). A CAS on
 * `status = 'scheduled'` plus the batch's `guard`: a send that fired or was canceled in
 * the gap changes zero rows without failing the batch, and is never touched.
 */
export function remakeSendStmt(
  db: D1Database,
  sendId: string,
  render: FrozenRender,
  now: number,
  guard: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sends SET rendered_html = ?, rendered_text = ?, subject = ?, remade_at = ?, rev = ${NEXT_REV}
        WHERE id = ? AND status = 'scheduled' AND ${guard.sql}`,
    )
    .bind(render.rendered_html, render.rendered_text, render.subject, now, sendId, ...guard.binds);
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

/** Sends left mid-flight whose lease has expired, and whose halt, if they carry one, is
 *  due its next retry by `retryDueBy` (SPEC §12): resume them. A send still waiting out its
 *  backoff costs the sweep nothing past this query. */
export async function resumableSends(
  db: D1Database,
  now: number,
  retryDueBy: number,
): Promise<SendRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sends WHERE status = 'sending' AND (locked_until IS NULL OR locked_until < ?)
          AND (halt_retry_at IS NULL OR halt_retry_at <= ?) ORDER BY started_at ASC`,
    )
    .bind(now, retryDueBy)
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
 * Acquire the send lease and move scheduled → sending. CAS: succeeds only if the send
 * is unleased (or the lease expired) AND it is either already `sending` (a resume) or a
 * `scheduled` send whose fire time has arrived. Returns the lease token naming this run,
 * or null when the caller does not own the send. Every later lease write and hand-off by
 * the run passes the token back, so a run whose lease expired under it (a stall past the
 * TTL) can no longer touch the send once a successor has taken it.
 *
 * The `fire_at <= now` guard on the scheduled branch is what closes the
 * reschedule-vs-sweep race: the sweep snapshots due sends (`dueSends`) and then leases
 * each one, and a `reschedule` that moves a just-due send forward lands in that gap. It
 * leaves the row `scheduled` (only `fire_at` changes), so a status-only CAS would still
 * fire it at its old time even though the API returned "rescheduled". Re-checking
 * `fire_at` here means a send moved back into the future is not leased or fired until its
 * new time — the counterpart to `reschedule`'s own `scheduled`-only guard (I6).
 */
export async function acquireLease(
  db: D1Database,
  sendId: string,
  now: number,
  leaseTtlMs: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const res = await db
    .prepare(
      `UPDATE sends
         SET status = CASE WHEN status = 'scheduled' THEN 'sending' ELSE status END,
             started_at = COALESCE(started_at, ?),
             locked_until = ?,
             lease_token = ?,
             rev = ${NEXT_REV}
       WHERE id = ?
         AND (status = 'sending' OR (status = 'scheduled' AND fire_at <= ?))
         AND (locked_until IS NULL OR locked_until < ?)`,
    )
    .bind(now, now + leaseTtlMs, token, sendId, now, now)
    .run();
  return (res.meta.changes ?? 0) > 0 ? token : null;
}

/** The predicate confining a write to the run that holds the send's lease. */
function holdsLease(sendId: string, lease: string): { sql: string; binds: unknown[] } {
  return {
    sql: "EXISTS (SELECT 1 FROM sends WHERE id = ? AND lease_token = ?)",
    binds: [sendId, lease],
  };
}

/** Extend this run's lease. False once another run holds it, which then owns the send.
 *  The one write to a send that takes no `rev`: a renewal changes nothing a reader sees. */
export async function renewLease(
  db: D1Database,
  sendId: string,
  lease: string,
  until: number,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE sends SET locked_until = ? WHERE id = ? AND lease_token = ?")
    .bind(until, sendId, lease)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Release this run's lease so the next tick may resume the send; a no-op once another
 *  run holds it. Unlike a renewal it stamps `rev`: whether a lease is held is what tells a
 *  wedged send (given up, awaiting Resolve) from one finishing its last batch. */
export async function releaseLease(db: D1Database, sendId: string, lease: string): Promise<void> {
  await db
    .prepare(
      `UPDATE sends SET locked_until = NULL, lease_token = NULL, rev = ${NEXT_REV} WHERE id = ? AND lease_token = ?`,
    )
    .bind(sendId, lease)
    .run();
}

/**
 * Mark a send complete and its post sent (atomic). `lease` is the send loop's token, so
 * a run that lost its lease cannot complete the send under its successor; the operator's
 * Resolve holds no lease and passes null.
 */
export async function completeSend(
  db: D1Database,
  sendId: string,
  postId: string,
  now: number,
  lease: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE sends SET status = 'sent', completed_at = ?, locked_until = NULL, lease_token = NULL,
                halt_reason = NULL, halt_cause = NULL, halt_error = NULL, halted_at = NULL,
                halt_retries = 0, halt_retry_at = NULL, rev = ${NEXT_REV}
          WHERE id = ? AND status = 'sending' AND (? IS NULL OR lease_token = ?)`,
      )
      .bind(now, sendId, lease, lease),
    db
      .prepare(
        `UPDATE posts SET status = 'sent', updated_at = ?
          WHERE id = ? AND status = 'scheduled'
            AND EXISTS (SELECT 1 FROM sends WHERE id = ? AND status = 'sent')`,
      )
      .bind(now, postId, sendId),
    // Exactness pass: rebuild the counters from the aggregate as the record becomes
    // permanent, so its numbers equal `deliveries` regardless of any live-delta drift.
    // Delivery events keep arriving after this and update the counters on their own.
    recomputeSendCountersStmt(db, sendId),
  ]);
}

/**
 * Fix the send's audience, once (SPEC §6, §8): confirmed subscribers minus suppressed
 * addresses as they stand now, inserted as `pending` deliveries. One batch, so one
 * transaction: the insert runs only while `audience_resolved_at` is null and the same
 * batch sets it, so a crash can't leave a send marked resolved without its rows, and a
 * resolved send is never widened by a later run. The same write sets `recipient_count`
 * to the audience at fire and `c_pending` to the rows queued. True when this call
 * resolved it, false when it already was.
 */
export async function resolveAudience(
  db: D1Database,
  sendId: string,
  now: number,
): Promise<boolean> {
  const [, mark] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (send_id, email, status, attempts, updated_at)
           SELECT ?, s.email, 'pending', 0, ?
             FROM subscribers s
            WHERE s.status = 'confirmed'
              AND s.email NOT IN (SELECT email FROM suppressions)
              AND EXISTS (SELECT 1 FROM sends WHERE id = ? AND audience_resolved_at IS NULL)`,
      )
      .bind(sendId, now, sendId),
    db
      .prepare(
        `UPDATE sends
            SET audience_resolved_at = ?,
                recipient_count = (SELECT COUNT(*) FROM deliveries WHERE send_id = sends.id),
                c_pending = (SELECT COUNT(*) FROM deliveries WHERE send_id = sends.id AND status = 'pending' AND event IS NULL),
                rev = ${NEXT_REV}
          WHERE id = ? AND audience_resolved_at IS NULL`,
      )
      .bind(now, sendId),
  ]);
  return (mark?.meta.changes ?? 0) > 0;
}

export interface DeliveryWork {
  id: number;
  email: string;
  attempts: number;
  unsub_token: string | null;
  sub_status: string | null;
  suppressed: number; // 0/1
}

/** A delivery row joined to its subscriber's consent state: what the loop reads at hand-off. */
const DELIVERY_WORK = `SELECT d.id AS id, d.email AS email, d.attempts AS attempts, s.unsub_token AS unsub_token,
         s.status AS sub_status, (sup.email IS NOT NULL) AS suppressed
    FROM deliveries d
    LEFT JOIN subscribers s ON s.email = d.email
    LEFT JOIN suppressions sup ON sup.email = d.email`;

/** Up to `limit` of a send's fresh `pending` rows (never handed off), oldest first. */
export async function pendingDeliveryIds(
  db: D1Database,
  sendId: string,
  limit: number,
): Promise<number[]> {
  const { results } = await db
    .prepare(
      "SELECT id FROM deliveries WHERE send_id = ? AND status = 'pending' AND dispatch_key IS NULL ORDER BY id ASC LIMIT ?",
    )
    .bind(sendId, limit)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** The hand-off state of the given rows. The ids travel as one JSON-array parameter,
 *  so a chunk of any size stays under D1's 100-parameter cap. */
export async function fetchDeliveryWork(db: D1Database, ids: number[]): Promise<DeliveryWork[]> {
  if (ids.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(`${DELIVERY_WORK} WHERE d.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<DeliveryWork>();
  return results;
}

/** An unanswered hand-off: its key, and when that key was first sent (null if unknown). */
export interface UnansweredKey {
  key: string;
  keyedAt: number | null;
}

/**
 * The keys of a send's unanswered hand-offs, oldest first: batches handed off under a
 * key whose outcome was never recorded, because the request got no answer or one that
 * left its fate unknown (the rows are back in `pending`, key kept) or the run ended
 * before recording it (still `dispatched`). `queuedOnly` limits it to the first kind,
 * which is all a provider without idempotency may act on: its `dispatched` rows are
 * Resolve's. So is a batch still in flight under a key sent before `keyedBefore`, which
 * the provider no longer remembers, so it is left out too rather than listed every tick.
 */
export async function unansweredDispatchKeys(
  db: D1Database,
  sendId: string,
  queuedOnly = false,
  keyedBefore: number | null = null,
): Promise<UnansweredKey[]> {
  const { results } = await db
    .prepare(
      `SELECT dispatch_key AS k, MIN(keyed_at) AS at FROM deliveries
        WHERE send_id = ? AND dispatch_key IS NOT NULL
          AND (status = 'pending'
            OR (? = 0 AND status = 'dispatched' AND (? IS NULL OR keyed_at IS NULL OR keyed_at >= ?)))
        GROUP BY dispatch_key ORDER BY MIN(rowid)`,
    )
    .bind(sendId, queuedOnly ? 1 : 0, keyedBefore, keyedBefore)
    .all<{ k: string; at: number | null }>();
  return results.map((r) => ({ key: r.k, keyedAt: r.at }));
}

/** The members of one unanswered hand-off, with their hand-off state. */
export async function fetchDispatchGroup(
  db: D1Database,
  sendId: string,
  key: string,
): Promise<DeliveryWork[]> {
  const { results } = await db
    .prepare(
      `${DELIVERY_WORK} WHERE d.send_id = ? AND d.dispatch_key = ? AND d.status IN ('pending', 'dispatched')`,
    )
    .bind(sendId, key)
    .all<DeliveryWork>();
  return results;
}

/** A statement moving every row of the hand-offs under `keys` that is in `status` between
 *  two counter buckets, lease-guarded like the row write it rides with. */
function keyedCounterMove(
  db: D1Database,
  sendId: string,
  lease: string,
  keys: string[],
  status: "pending" | "dispatched",
  from: CounterCol,
  to: CounterCol,
): D1PreparedStatement {
  const n = `(SELECT COUNT(*) FROM deliveries WHERE send_id = ?
      AND dispatch_key IN (SELECT value FROM json_each(?)) AND status = ?)`;
  const k = JSON.stringify(keys);
  return db
    .prepare(
      `UPDATE sends SET ${from} = ${from} - ${n}, ${to} = ${to} + ${n}, rev = ${NEXT_REV} WHERE id = ? AND lease_token = ?`,
    )
    .bind(sendId, k, status, sendId, k, status, sendId, lease);
}

/** One batch to hand off: the rows it covers and the dispatch key it goes out under. */
export interface HandOff {
  key: string;
  ids: number[];
}

/**
 * Hand off fresh `pending` rows, each batch under its own new dispatch key: the intent
 * recorded before any request leaves. Several batches share the one write, so a group of
 * one-recipient batches costs what one batch does. Only rows still `pending` and never
 * handed off move, and only while `lease` holds the send; returns the rows that moved,
 * with their keys, which are the only ones to send.
 */
export async function dispatchFresh(
  db: D1Database,
  sendId: string,
  lease: string,
  handOffs: HandOff[],
  now: number,
): Promise<{ id: number; key: string }[]> {
  const rows = handOffs.flatMap((h) => h.ids.map((id) => ({ id, k: h.key })));
  if (rows.length === 0) {
    return [];
  }
  const json = JSON.stringify(rows);
  const guard = holdsLease(sendId, lease);
  const [moved] = await db.batch<{ id: number; key: string }>([
    // Rows are found by primary key (the unary `+` keeps SQLite off the (send_id, status)
    // index, which would walk every pending row of the send for each group), and each
    // takes its own batch's key.
    db
      .prepare(
        `UPDATE deliveries SET status = 'dispatched',
                dispatch_key = (SELECT json_extract(j.value, '$.k') FROM json_each(?) AS j
                                 WHERE json_extract(j.value, '$.id') = deliveries.id),
                keyed_at = ?, updated_at = ?
          WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
            AND +send_id = ? AND +status = 'pending' AND dispatch_key IS NULL AND ${guard.sql}
          RETURNING id, dispatch_key AS key`,
      )
      .bind(json, now, now, json, sendId, ...guard.binds),
    // After the move, so it counts exactly the rows that took the (new) keys.
    keyedCounterMove(
      db,
      sendId,
      lease,
      handOffs.map((h) => h.key),
      "dispatched",
      "c_pending",
      "c_in_flight",
    ),
  ]);
  return moved?.results ?? [];
}

/**
 * Hand off an unanswered batch again, under its own key: rows an unanswered request sent
 * back to `pending` move to `dispatched` (rows a crash left `dispatched` already are).
 * `queuedOnly` moves only the `pending` ones and leaves rows already in flight untouched,
 * for a batch that is going to Resolve rather than to the provider. Lease-guarded;
 * returns the ids it moved (with `queuedOnly`) or now in flight under the key.
 */
export async function redispatch(
  db: D1Database,
  sendId: string,
  lease: string,
  key: string,
  now: number,
  queuedOnly = false,
): Promise<number[]> {
  const guard = holdsLease(sendId, lease);
  const [, moved] = await db.batch<{ id: number }>([
    // Before the move, so it counts the rows about to leave `pending`.
    keyedCounterMove(db, sendId, lease, [key], "pending", "c_pending", "c_in_flight"),
    db
      .prepare(
        `UPDATE deliveries SET status = 'dispatched', updated_at = ?
          WHERE send_id = ? AND dispatch_key = ?
            AND status IN (${queuedOnly ? "'pending'" : "'pending', 'dispatched'"}) AND ${guard.sql}
          RETURNING id`,
      )
      .bind(now, sendId, key, ...guard.binds),
  ]);
  return (moved?.results ?? []).map((r) => r.id);
}

/** A halted batch going back to the queue, and whether it keeps its dispatch key. */
export interface HeldBatch {
  key: string;
  keepKey: boolean;
}

/**
 * Batches the provider refused as a whole, or requests that got no answer: the failure
 * is the provider's or the account's, not the recipients', so their rows go back to
 * `pending` with no attempt spent, and the send records the halt (SPEC §12). `keepKey`
 * keeps a batch's key, so the next run re-sends that exact batch under it instead of
 * folding the rows into a new one the provider could not recognize (I4); without it the
 * rows are fresh again, and go back through the consent check at hand-off (I2).
 * `halted_at` keeps the start of an unbroken run of refusals for the same reason, and
 * `halt_retries` counts the run's halts, which picks the next retry's delay from `backoff`
 * (the reason's schedule, in ms, its last step repeating): the sweep leaves the send
 * alone until `halt_retry_at`. A new reason starts its schedule from the top. However
 * many batches of a group halted, the send records one halt. With no `halt`, the batches
 * were handed off but never sent (a group stopped short), so they only go back to the
 * queue and the send's halt state is left as it was. Lease-guarded, and three statements
 * in all (two with no halt).
 */
export async function holdBatch(
  db: D1Database,
  sendId: string,
  lease: string,
  held: HeldBatch[],
  halt: { reason: HaltReason; cause: HaltCause; error: string } | null,
  backoff: readonly number[],
  now: number,
): Promise<void> {
  if (held.length === 0) {
    return;
  }
  const guard = holdsLease(sendId, lease);
  // The halts before this one in an unbroken run for this reason, capped at the last step.
  const step = `MIN(CASE WHEN halt_reason IS ? THEN halt_retries ELSE 0 END, ${backoff.length - 1})`;
  const rows = held.map((h) => ({ k: h.key, keep: h.keepKey ? 1 : 0 }));
  const statements = [
    // Before the move, so it counts the rows still under the keys.
    keyedCounterMove(
      db,
      sendId,
      lease,
      held.map((h) => h.key),
      "dispatched",
      "c_in_flight",
      "c_pending",
    ),
    db
      .prepare(
        `UPDATE deliveries SET status = 'pending', error = ?, updated_at = ?,
                dispatch_key = CASE WHEN json_extract(j.value, '$.keep') = 1 THEN dispatch_key END,
                keyed_at = CASE WHEN json_extract(j.value, '$.keep') = 1 THEN keyed_at END
           FROM json_each(?) AS j
          WHERE deliveries.send_id = ? AND deliveries.dispatch_key = json_extract(j.value, '$.k')
            AND deliveries.status = 'dispatched' AND ${guard.sql}`,
      )
      .bind(halt?.error ?? null, now, JSON.stringify(rows), sendId, ...guard.binds),
  ];
  if (halt) {
    statements.push(
      db
        .prepare(
          `UPDATE sends SET halt_reason = ?, halt_cause = ?, halt_error = ?,
                  halted_at = CASE WHEN halt_reason IS ? THEN halted_at ELSE ? END,
                  halt_retries = CASE WHEN halt_reason IS ? THEN halt_retries + 1 ELSE 1 END,
                  halt_retry_at = ? + json_extract(?, '$[' || ${step} || ']'),
                  rev = ${NEXT_REV}
            WHERE id = ? AND lease_token = ?`,
        )
        .bind(
          halt.reason,
          halt.cause,
          halt.error,
          halt.reason,
          now,
          halt.reason,
          now,
          JSON.stringify(backoff),
          halt.reason,
          sendId,
          lease,
        ),
    );
  }
  await db.batch(statements);
}

/**
 * One recipient's recorded outcome. `pending` is a retryable rejection: back in the queue
 * for the next tick, one attempt spent. `keepKey` keeps its dispatch key, so the batch is
 * re-sent under that key rather than folded into a new one: on an idempotent provider a
 * retryable answer (a 429, a 5xx) does not prove the batch was not accepted, and only the
 * same key lets the provider dedupe it.
 */
export type DeliveryOutcome =
  | { id: number; status: "accepted"; providerId: string }
  | { id: number; status: "unsent"; error: string }
  | { id: number; status: "skipped" }
  | { id: number; status: "pending"; error: string; keepKey: boolean };

const OUTCOME_BUCKET: Record<DeliveryOutcome["status"], CounterCol> = {
  accepted: "c_accepted",
  unsent: "c_unsent",
  skipped: "c_skipped",
  pending: "c_pending",
};

/**
 * Record a chunk's outcomes in one statement and its counter move, not a D1 call per
 * recipient. `from` is the status the rows leave: `pending` for a recipient closed before
 * hand-off (unsubscribed, suppressed, or out of attempts), `dispatched` for the
 * provider's answer. Every outcome but a `keepKey` retry clears the dispatch key, since
 * the hand-off is answered. `answered` says the provider actually answered this batch,
 * which ends any halt the send carried; closing rows without asking it does not. Lease-guarded: a
 * run that lost its lease records nothing, and the successor re-sends the batch under the
 * same key and records the provider's answer itself.
 */
export async function settleDeliveries(
  db: D1Database,
  sendId: string,
  lease: string,
  from: "pending" | "dispatched",
  outcomes: DeliveryOutcome[],
  now: number,
  answered = false,
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }
  const rows = outcomes.map((o) => ({
    id: o.id,
    s: o.status,
    // An adapter that got no message id back reports it empty; the record stores that as
    // no id, which the unique index on provider ids leaves out.
    p: o.status === "accepted" && o.providerId !== "" ? o.providerId : null,
    e: o.status === "unsent" || o.status === "pending" ? o.error : null,
    k: o.status === "pending" && o.keepKey ? 1 : 0,
  }));
  const deltas = new Map<CounterCol, number>();
  const bump = (col: CounterCol, n: number) => deltas.set(col, (deltas.get(col) ?? 0) + n);
  bump(from === "pending" ? "c_pending" : "c_in_flight", -outcomes.length);
  for (const o of outcomes) {
    bump(OUTCOME_BUCKET[o.status], 1);
  }
  const cols = [...deltas.keys()];
  const sets = cols.map((c) => `${c} = ${c} + ?`);
  if (answered) {
    sets.push(
      "halt_reason = NULL",
      "halt_cause = NULL",
      "halt_error = NULL",
      "halted_at = NULL",
      "halt_retries = 0",
      "halt_retry_at = NULL",
    );
  }
  const guard = holdsLease(sendId, lease);
  // Rows are found by primary key; see `dispatchFresh` for the unary `+`.
  const json = JSON.stringify(rows);
  await db.batch([
    db
      .prepare(
        `UPDATE deliveries SET
           status = json_extract(j.value, '$.s'),
           provider_id = COALESCE(json_extract(j.value, '$.p'), provider_id),
           error = json_extract(j.value, '$.e'),
           attempts = attempts + (json_extract(j.value, '$.s') = 'pending'),
           dispatch_key = CASE WHEN json_extract(j.value, '$.k') = 1 THEN dispatch_key END,
           keyed_at = CASE WHEN json_extract(j.value, '$.k') = 1 THEN keyed_at END,
           updated_at = ?
         FROM json_each(?) AS j
         WHERE deliveries.id = json_extract(j.value, '$.id')
           AND deliveries.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
           AND +deliveries.send_id = ? AND +deliveries.status = ? AND ${guard.sql}`,
      )
      .bind(now, json, json, sendId, from, ...guard.binds),
    // The column names come from the fixed `CounterCol` union, never user input.
    db
      .prepare(
        `UPDATE sends SET ${sets.join(", ")}, rev = ${NEXT_REV} WHERE id = ? AND lease_token = ?`,
      )
      .bind(...cols.map((c) => deltas.get(c) ?? 0), sendId, lease),
  ]);
}

/** How many of a send's recipients are still open (`pending` or `dispatched`): the
 *  completion gate, zero when every recipient is accepted or terminal. */
export async function openDeliveryCount(db: D1Database, sendId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND status IN ('pending', 'dispatched')",
    )
    .bind(sendId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Operator adjudication of a wedged send's ambiguous rows (SPEC §12). Moves every
 * still-`dispatched` row of a send to a terminal state the operator chose —
 * `unsent` (assume the batch never left) or `accepted` (assume it did) — stamping
 * the reason into `error` as an inspectable audit trail. It touches ONLY
 * `dispatched` rows, so an already-`accepted` recipient is never disturbed, and it
 * never re-mails anyone (nothing here calls the provider). Only while `lease` holds the
 * send, so no run is waiting on those rows' answers. Returns rows resolved.
 */
export async function resolveDispatched(
  db: D1Database,
  sendId: string,
  lease: string,
  outcome: "unsent" | "accepted",
  note: string,
  now: number,
): Promise<number> {
  const guard = holdsLease(sendId, lease);
  const res = await db
    .prepare(
      `UPDATE deliveries SET status = ?, error = ?, dispatch_key = NULL, keyed_at = NULL, updated_at = ?
        WHERE send_id = ? AND status = 'dispatched' AND ${guard.sql}`,
    )
    .bind(outcome, note, now, sendId, ...guard.binds)
    .run();
  const n = res.meta.changes ?? 0;
  if (n > 0) {
    // A dispatched row carries no webhook event yet, so it leaves c_in_flight for the
    // adjudicated terminal bucket.
    await counterMove(
      db,
      sendId,
      "c_in_flight",
      outcome === "unsent" ? "c_unsent" : "c_accepted",
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

export type DeliveryEventType = "delivered" | "bounced" | "complained";

export interface DeliveryEventUpdate {
  /** The provider's message id stored on the delivery row: the match key whenever present. */
  providerId?: string;
  /** Recipient address: the match key only when the event carries no provider id. */
  email?: string;
  event: DeliveryEventType;
  detail?: string | null;
  /** For a `bounced` event: whether the provider reported it as a permanent (hard)
   *  bounce. Recorded as the delivery row's frozen soft/hard fact for the record view
   *  (SPEC §8), so the split never depends on the mutable, cross-send `suppressions`
   *  table. Ignored for non-bounce events (they clear any prior kind). */
  hard?: boolean;
  at: number;
}

export interface DeliveryEventResult {
  /** Rows updated (0 or 1). */
  changes: number;
  /**
   * The matched row's recipient address, or null if nothing matched. Set even when the
   * event lost to a worse one already recorded, so a caller that received an event
   * carrying only a `provider_id` (no `email`) still recovers the address for a
   * suppression decision: the suppression guarantee (I1) must not depend on the provider
   * echoing the recipient back.
   */
  email: string | null;
  /** The matched row's send, or null if nothing matched. */
  sendId: string | null;
}

// How bad an outcome is. SNS does not guarantee order, so a later event may be a better
// one (a `delivered` after a `complained`); the record keeps the worst it has seen.
function eventRank(event: string | null, bounceKind: string | null): number {
  switch (event) {
    case "complained":
      return 4;
    case "bounced":
      return bounceKind === "hard" ? 3 : 2;
    case "delivered":
      return 1;
    default:
      return 0;
  }
}

/**
 * Record an out-of-band provider event (delivered/bounced/complained) on the matching
 * delivery row, unless the row already holds a worse outcome. An event with a provider
 * id matches by it (unique per delivery). One whose id matches nothing may land only on
 * the address's most recent accepted row that never learned its id, which is a recipient
 * the publisher resolved as sent (SPEC §12), whose receipt still has to land; otherwise
 * it is dropped, since test sends and confirmation emails have no delivery row and their
 * events must never land on a real send's record (SPEC §8). An event carrying no provider
 * id at all falls back to the address's most recent delivery. Never touches the
 * send-loop `status`, which is a separate, earlier signal.
 */
export async function markDeliveryEvent(
  db: D1Database,
  u: DeliveryEventUpdate,
): Promise<DeliveryEventResult> {
  const detail = u.detail ?? null;
  // Locate the target row first so the counter delta knows the bucket it is leaving (an
  // event can land on an `accepted` row, or overwrite an earlier event).
  type Target = {
    id: number;
    send_id: string;
    email: string;
    status: string;
    event: string | null;
    bounce_kind: string | null;
  };
  const cols = "id, send_id, email, status, event, bounce_kind";
  let row: Target | null = null;
  if (u.providerId) {
    row = await db
      .prepare(`SELECT ${cols} FROM deliveries WHERE provider_id = ? LIMIT 1`)
      .bind(u.providerId)
      .first<Target>();
    if (!row && u.email) {
      // An id-less accepted row: resolved as sent, or an SES answer whose body was unreadable.
      row = await db
        .prepare(
          `SELECT ${cols} FROM deliveries
            WHERE email = ? AND status = 'accepted' AND (provider_id IS NULL OR provider_id = '')
            ORDER BY updated_at DESC LIMIT 1`,
        )
        .bind(normalizeEmail(u.email))
        .first<Target>();
    }
  } else if (u.email) {
    row = await db
      .prepare(`SELECT ${cols} FROM deliveries WHERE email = ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(normalizeEmail(u.email))
      .first<Target>();
  }
  if (!row) {
    return { changes: 0, email: null, sendId: null };
  }

  // Freeze the soft/hard split as a fact of this send (SPEC §8): a bounce records the
  // provider's hard/soft signal; any other event clears it (the row is no longer a bounce).
  const bounceKind = u.event === "bounced" ? (u.hard ? "hard" : "soft") : null;
  if (eventRank(u.event, bounceKind) < eventRank(row.event, row.bounce_kind)) {
    return { changes: 0, email: row.email, sendId: row.send_id };
  }

  const fromCol = bucketCol(row.status, row.event);
  const toCol = bucketCol(row.status, u.event);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE deliveries SET event = ?, event_detail = ?, event_at = ?, bounce_kind = ? WHERE id = ?",
      )
      .bind(u.event, detail, u.at, bounceKind, row.id),
  ];
  if (fromCol !== toCol) {
    stmts.push(counterMove(db, row.send_id, fromCol, toCol, 1));
  }
  await db.batch(stmts);
  return { changes: 1, email: row.email, sendId: row.send_id };
}

/** An accepted recipient with no delivery event yet — a candidate for the dev send
 *  simulation to fabricate a delayed delivered / bounced / complained webhook against
 *  (see src/providers/simulate.ts). Read-only; never used by the real send path. */
export interface AcceptedAwaitingEvent {
  send_id: string;
  email: string;
  provider_id: string | null;
  updated_at: number;
  /** The send's recipient count (the audience at fire once it has fired), so the simulation can scale a per-send rate
   *  (e.g. a small-list complaint floor) to the audience size. */
  recipient_count: number;
}

/** Accepted-but-unconfirmed deliveries of in-flight or recently-sent sends, oldest
 *  first, for the dev simulation's delayed synthetic webhooks. Bounded by `limit`. */
export async function acceptedAwaitingEvent(
  db: D1Database,
  limit: number,
): Promise<AcceptedAwaitingEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT d.send_id AS send_id, d.email AS email, d.provider_id AS provider_id, d.updated_at AS updated_at, s.recipient_count AS recipient_count
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

/** A send with deliveries left in flight past the threshold, and how many. */
export interface StaleDispatched {
  send_id: string;
  post_id: string;
  n: number;
}

/** Dispatched rows older than a threshold, counted per send: ambiguous on non-idempotent
 *  providers, so the send is wedged until Resolve. One statement, whatever the count. */
export async function staleDispatched(
  db: D1Database,
  olderThan: number,
): Promise<StaleDispatched[]> {
  const { results } = await db
    .prepare(
      `SELECT d.send_id AS send_id, s.post_id AS post_id, COUNT(*) AS n
         FROM deliveries d JOIN sends s ON s.id = d.send_id
        WHERE d.status = 'dispatched' AND d.updated_at < ?
        GROUP BY d.send_id, s.post_id`,
    )
    .bind(olderThan)
    .all<StaleDispatched>();
  return results;
}
