/**
 * Template revision queries. The email template has a history (SPEC §9): every save
 * writes a full-text row here, the current template is the latest, and a send pins
 * the revision it was made with (`sends.template_revision`). Rows are append-only —
 * a restore writes a new row equal to an old one — so a pinned revision always still
 * exists and still says what it said. Which row is *current* is the settings blob's
 * pointer (`AppSettings.emailTemplateRevision`); the orchestration that keeps the two
 * in step lives in services/template_history.ts, so this module is only the table.
 */

export interface TemplateRevisionRow {
  id: string;
  html: string;
  saved_at: number;
  /** Principal that saved it; null for the app's own first-use record. */
  author: string | null;
}

/** A revision as the API names it: the id and when it was saved. The html is left
 *  out — the current template's html is on the settings surface, and history rows are
 *  restored, not read. */
export interface TemplateRevisionRef {
  revision: string;
  saved_at: number;
}

/** History-list view: everything but the (potentially 40 KB) html. */
export type TemplateRevisionSummary = Omit<TemplateRevisionRow, "html">;

export function templateRevisionRef(row: TemplateRevisionRow): TemplateRevisionRef {
  return { revision: row.id, saved_at: row.saved_at };
}

export function getTemplateRevision(
  db: D1Database,
  id: string,
): Promise<TemplateRevisionRow | null> {
  return db
    .prepare("SELECT * FROM template_revisions WHERE id = ?")
    .bind(id)
    .first<TemplateRevisionRow>();
}

/** The history, newest first. */
export async function listTemplateRevisions(
  db: D1Database,
  limit = 200,
): Promise<TemplateRevisionSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT id, saved_at, author FROM template_revisions ORDER BY saved_at DESC, id DESC LIMIT ?",
    )
    .bind(Math.min(limit, 1000))
    .all<TemplateRevisionSummary>();
  return results;
}

/** Of `ids`, the revisions that exist and hold exactly `html` — one query, no html
 *  transferred, so a polled list can ask about every scheduled send's revision at once.
 *  An id absent from the result either differs or has no row. Chunked to stay under
 *  D1's bind limit. */
export async function revisionsWithHtml(
  db: D1Database,
  ids: string[],
  html: string,
): Promise<Set<string>> {
  const matching = new Set<string>();
  const distinct = [...new Set(ids)];
  for (let i = 0; i < distinct.length; i += 50) {
    const chunk = distinct.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT id FROM template_revisions WHERE html = ? AND id IN (${marks})`)
      .bind(html, ...chunk)
      .all<{ id: string }>();
    for (const r of results) {
      matching.add(r.id);
    }
  }
  return matching;
}

/** The INSERT for one revision, as a statement so the caller can batch it with the
 *  settings write that points at it — the two must land together or not at all. */
export function insertTemplateRevisionStmt(
  db: D1Database,
  row: TemplateRevisionRow,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO template_revisions (id, html, saved_at, author) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.html, row.saved_at, row.author);
}
