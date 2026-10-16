/**
 * The SQL of an import and an export (SPEC §7, §8): reading the list as it stands for the
 * addresses in a file, the import's one atomic batch of writes, its record, and the whole
 * list in the export's shape.
 *
 * Every write is set-based: one `json_each` statement per kind of write and per chunk of
 * rows, never one per row, with each chunk's JSON held under D1's limit on one value. Each
 * statement re-checks the list as it stands when it runs (a guard), so a reader who
 * unsubscribed, or an address suppressed, since the plan was made is never confirmed, and
 * `RETURNING` reports which addresses each write actually changed.
 */

import type { ImportRecord, OptIn, OutcomeCounts } from "../../shared/imports";
import type { SubscriberStatus } from "../../shared/subscribers";
import { importNotice } from "./notifications";
import { ERASED } from "./subscribers";

/**
 * The most bytes of JSON one statement binds. D1 refuses a string over 2,000,000 bytes;
 * half of it leaves room for the rest of a row and for any estimate being off.
 */
export const MAX_VALUE_BYTES = 1_000_000;

const encoder = new TextEncoder();
const NON_ASCII = /[\u0080-\uffff]/;

/** Items as JSON arrays, each under `MAX_VALUE_BYTES`, in order. */
export function jsonChunks(items: readonly unknown[], maxBytes = MAX_VALUE_BYTES): string[] {
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const part = JSON.stringify(item);
    // Most rows are ASCII, whose length is its size; only the rest are encoded to count.
    const size = (NON_ASCII.test(part) ? encoder.encode(part).length : part.length) + 1;
    if (parts.length > 0 && bytes + size > maxBytes) {
      chunks.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 2;
    }
    parts.push(part);
    bytes += size;
  }
  if (parts.length > 0) {
    chunks.push(`[${parts.join(",")}]`);
  }
  return chunks;
}

/** What an address's subscriber is here, as far as an import cares. */
export interface ListEntry {
  status: SubscriberStatus;
  import_id: string | null;
  confirmed_at: number | null;
  /** When they last left, kept while they are pending again. */
  unsubscribed_at: number | null;
}

/** The list as it stands for some addresses: their subscribers, and their suppressions' reasons. */
export interface ListState {
  subscribers: Map<string, ListEntry>;
  suppressions: Map<string, string>;
}

/** Read the list for `emails` (normalized), a chunk of them per statement, in one batch. */
export async function readListState(db: D1Database, emails: readonly string[]): Promise<ListState> {
  const state: ListState = { subscribers: new Map(), suppressions: new Map() };
  const chunks = jsonChunks(emails);
  if (chunks.length === 0) {
    return state;
  }
  const statements = chunks.flatMap((chunk) => [
    db
      .prepare(
        "SELECT email, status, import_id, confirmed_at, unsubscribed_at FROM subscribers WHERE email IN (SELECT value FROM json_each(?))",
      )
      .bind(chunk),
    db
      .prepare(
        "SELECT email, reason FROM suppressions WHERE email IN (SELECT value FROM json_each(?))",
      )
      .bind(chunk),
  ]);
  const results = await db.batch<Record<string, unknown>>(statements);
  results.forEach((res, i) => {
    for (const r of res.results) {
      if (i % 2 === 0) {
        state.subscribers.set(r.email as string, {
          status: r.status as SubscriberStatus,
          import_id: r.import_id as string | null,
          confirmed_at: r.confirmed_at as number | null,
          unsubscribed_at: r.unsubscribed_at as number | null,
        });
      } else {
        state.suppressions.set(r.email as string, r.reason as string);
      }
    }
  });
  return state;
}

/**
 * The sends whose audience is not fixed yet, so an import can grow them: every scheduled send,
 * and a send that has fired but whose run stopped before it resolved its audience.
 */
export async function scheduledSends(
  db: D1Database,
): Promise<{ id: string; subject: string; fire_at: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, subject, fire_at FROM sends
        WHERE status = 'scheduled' OR (status = 'sending' AND audience_resolved_at IS NULL)
        ORDER BY fire_at ASC, id ASC`,
    )
    .all<{ id: string; subject: string; fire_at: number }>();
  return results;
}

interface ImportRow {
  id: string;
  created_at: number;
  principal_kind: "human" | "service";
  principal_email: string | null;
  attestation_version: number | null;
  file_name: string;
  file_sha256: string;
  plan_hash: string;
  counts: string;
  suppressions_added: number;
}

function toRecord(row: ImportRow): ImportRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    principal: { kind: row.principal_kind, email: row.principal_email },
    attestation_version: row.attestation_version,
    file_name: row.file_name,
    file_sha256: row.file_sha256,
    plan_hash: row.plan_hash,
    counts: JSON.parse(row.counts) as OutcomeCounts,
    suppressions_added: row.suppressions_added,
  };
}

/** The id of the import committed last, or null before the first. */
export async function latestImportId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM imports ORDER BY created_at DESC, id DESC LIMIT 1")
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** The import a plan was committed as, if it was. */
export async function getImportByPlanHash(
  db: D1Database,
  planHash: string,
): Promise<ImportRecord | null> {
  const row = await db
    .prepare("SELECT * FROM imports WHERE plan_hash = ?")
    .bind(planHash)
    .first<ImportRow>();
  return row ? toRecord(row) : null;
}

/** A subscriber the import confirms or adds, with the provenance the import gives them. */
export interface ConsentRow {
  e: string;
  opt: OptIn;
  org: string;
  ev: string | null;
  /** The source's confirmation time (its `confirmed_at`, else its `subscribed_at`), or null. */
  cat: number | null;
}

/** A new subscriber's ids, beside its consent. */
export interface NewRow extends ConsentRow {
  id: string;
  tok: string;
  /** For an unsubscribed one, when the source says they left, or null. */
  uat: number | null;
}

/** Everything one import writes. Each list holds the rows its plan meant for that write. */
export interface ImportWrites {
  record: Omit<ImportRecord, "counts" | "principal"> & {
    principal_kind: "human" | "service";
    principal_email: string | null;
    counts: OutcomeCounts;
  };
  unsubscribe: { e: string; uat: number | null }[];
  addUnsubscribed: NewRow[];
  confirm: ConsentRow[];
  addConfirmed: NewRow[];
  suppress: { e: string; r: string; at: number | null }[];
  /** Whether to tell the publisher of the import (one Claude committed, SPEC §8). */
  notice: boolean;
}

/** The addresses each write actually changed. */
export interface AppliedWrites {
  unsubscribed: Set<string>;
  addedUnsubscribed: Set<string>;
  confirmed: Set<string>;
  addedConfirmed: Set<string>;
  suppressed: Set<string>;
}

// The JSON fields of the row a statement is reading, by name.
const v = (field: string) => `json_extract(j.value, '$.${field}')`;

/**
 * Apply an import in one batch, all of it or none: its record first (every row it touches
 * names it), then, each guarded against the list as it stands, the unsubscribes, the new
 * unsubscribed addresses, the confirmations of pending subscribers, the new confirmed ones,
 * the suppressions, and the publisher's notice. Confirmations run before the suppressions
 * so a row's own bounce lands beside its subscriber; a suppression already here holds any
 * confirmation back, an erased marker included, and is never replaced, and an erased marker
 * holds back a new unsubscribed address too, since no import brings back an erased person's
 * data (SPEC §7). Throws on a second
 * import of the same plan (`plan_hash` is unique), having written nothing.
 */
export async function applyImport(
  db: D1Database,
  writes: ImportWrites,
  suppressionDetail: string,
): Promise<AppliedWrites> {
  const r = writes.record;
  const now = r.created_at;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO imports (id, created_at, principal_kind, principal_email, attestation_version,
                              file_name, file_sha256, plan_hash, counts, suppressions_added)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        now,
        r.principal_kind,
        r.principal_email,
        r.attestation_version,
        r.file_name,
        r.file_sha256,
        r.plan_hash,
        JSON.stringify(r.counts),
        r.suppressions_added,
      ),
  ];
  const kinds: (keyof AppliedWrites)[] = [];
  const add = (
    kind: keyof AppliedWrites,
    sql: string,
    rows: readonly unknown[],
    ...binds: unknown[]
  ) => {
    for (const chunk of jsonChunks(rows)) {
      statements.push(db.prepare(sql).bind(chunk, ...binds));
      kinds.push(kind);
    }
  };

  // Unsubscribe a pending or confirmed subscriber, unless they confirmed here (not by an
  // import) after the source says they left: their newer act stands.
  add(
    "unsubscribed",
    `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = COALESCE(${v("uat")}, ?2)
       FROM json_each(?1) AS j
      WHERE subscribers.email = ${v("e")}
        AND subscribers.status IN ('pending', 'confirmed')
        AND NOT (subscribers.status = 'confirmed' AND subscribers.import_id IS NULL
                 AND ${v("uat")} IS NOT NULL AND COALESCE(subscribers.confirmed_at, 0) > ${v("uat")})
      RETURNING email`,
    writes.unsubscribe,
    now,
  );
  // An address that left before it came here is recorded as unsubscribed, unless it was
  // erased here: a subscriber row would bring back the data the erasure removed.
  add(
    "addedUnsubscribed",
    `INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at, unsubscribed_at,
                              origin, opt_in, consent_evidence, import_id)
     SELECT ${v("id")}, ${v("e")}, 'unsubscribed', ${v("tok")}, ?2, ${v("cat")}, COALESCE(${v("uat")}, ?2),
            ${v("org")}, ${v("opt")}, ${v("ev")}, ?3
       FROM json_each(?1) AS j
      WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = ${v("e")} AND s.reason = ?4)
     ON CONFLICT (email) DO NOTHING
     RETURNING email`,
    writes.addUnsubscribed,
    now,
    r.id,
    ERASED,
  );
  // Confirm a subscriber still pending here who never left, with no suppression here; its
  // link stops working. A pending row that once left was put back by whoever typed its
  // address into the form, not by its owner, so its unsubscribe stands (I2).
  add(
    "confirmed",
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = ${v("cat")}, confirm_token = NULL,
                            origin = ${v("org")}, opt_in = ${v("opt")}, consent_evidence = ${v("ev")},
                            import_id = ?2
       FROM json_each(?1) AS j
      WHERE subscribers.email = ${v("e")} AND subscribers.status = 'pending'
        AND subscribers.unsubscribed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = subscribers.email)
      RETURNING email`,
    [...writes.confirm, ...writes.addConfirmed],
    r.id,
  );
  // Add an address new here, with no suppression here, as confirmed.
  add(
    "addedConfirmed",
    `INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at,
                              origin, opt_in, consent_evidence, import_id)
     SELECT ${v("id")}, ${v("e")}, 'confirmed', ${v("tok")}, ?2, ${v("cat")},
            ${v("org")}, ${v("opt")}, ${v("ev")}, ?3
       FROM json_each(?1) AS j
      WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = ${v("e")})
     ON CONFLICT (email) DO NOTHING
     RETURNING email`,
    writes.addConfirmed,
    now,
    r.id,
  );
  // Suppress an address with no suppression here; the first one stands, except over an
  // erased marker, which any other reason replaces, as `addSuppression` rules: a bounce or a
  // complaint must still stop the address being sent confirmations.
  add(
    "suppressed",
    `INSERT INTO suppressions (email, reason, detail, created_at)
     SELECT ${v("e")}, ${v("r")}, ?2, COALESCE(${v("at")}, ?3) FROM json_each(?1) AS j WHERE true
     ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail,
                                       created_at = excluded.created_at
      WHERE suppressions.reason = 'erased' AND excluded.reason <> 'erased'
     RETURNING email`,
    writes.suppress,
    suppressionDetail,
    now,
  );
  if (writes.notice) {
    statements.push(importNotice(db, r.id, now));
  }

  const results = await db.batch<{ email: string }>(statements);
  const applied: AppliedWrites = {
    unsubscribed: new Set(),
    addedUnsubscribed: new Set(),
    confirmed: new Set(),
    addedConfirmed: new Set(),
    suppressed: new Set(),
  };
  kinds.forEach((kind, i) => {
    for (const row of results[i + 1]?.results ?? []) {
      applied[kind].add(row.email);
    }
  });
  return applied;
}

/** Correct an import's counts to what was applied, when the list moved during its commit. */
export async function setImportCounts(
  db: D1Database,
  id: string,
  counts: OutcomeCounts,
  suppressionsAdded: number,
): Promise<void> {
  await db
    .prepare("UPDATE imports SET counts = ?, suppressions_added = ? WHERE id = ?")
    .bind(JSON.stringify(counts), suppressionsAdded, id)
    .run();
}

/** One address of the whole list, as the export reads it. */
export interface ListRow {
  email: string;
  /** Null for an address suppressed with no subscriber behind it. */
  status: SubscriberStatus | null;
  opt_in: OptIn | null;
  origin: string | null;
  consent_evidence: string | null;
  created_at: number | null;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  reason: string | null;
  suppressed_at: number | null;
}

/**
 * Up to `limit` addresses after `after` (or from the start, when null), in address order:
 * each subscriber with their suppression, and each suppression with no subscriber. Keyed on
 * the address, so a page never skips or repeats one while the list changes between pages.
 * Each half reads its own index up to `limit` before the two are merged.
 */
export async function listForExport(
  db: D1Database,
  after: string | null,
  limit: number,
): Promise<ListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT s.email, s.status, s.opt_in, s.origin, s.consent_evidence, s.created_at,
                s.confirmed_at, s.unsubscribed_at, p.reason, p.created_at AS suppressed_at
           FROM subscribers s LEFT JOIN suppressions p ON p.email = s.email
          WHERE s.email > ?1 ORDER BY s.email LIMIT ?2)
       UNION ALL
       SELECT * FROM (
         SELECT p.email, NULL, NULL, NULL, NULL, NULL, NULL, NULL, p.reason, p.created_at
           FROM suppressions p
          WHERE p.email > ?1 AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.email = p.email)
          ORDER BY p.email LIMIT ?2)
       ORDER BY 1 LIMIT ?2`,
    )
    .bind(after ?? "", limit)
    .all<ListRow>();
  return results;
}
