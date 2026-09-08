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

/** Per-recipient state rollup for a send (all zero until M6 populates deliveries). */
export async function deliveryRollup(
  db: D1Database,
  sendId: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE send_id = ? GROUP BY status")
    .bind(sendId)
    .all<{ status: string; n: number }>();
  const rollup: Record<string, number> = {};
  for (const r of results) rollup[r.status] = r.n;
  return rollup;
}
