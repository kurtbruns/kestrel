/**
 * Dev-only seed SQL: a full reset plus bulk inserts for every table. All seed
 * SQL lives here so `db/` stays the one place that holds SQL; the dataset itself
 * (content, render calls, image bytes) lives in `src/dev/seed.ts`. These helpers
 * set fields production never sets directly — backdated timestamps, `status='sent'`
 * sends, delivery events — which is exactly why they are seed-only and not part of
 * the normal `db/` write path. Only the fake-provider seed route calls them.
 */
import type { PostStatus } from "./posts";
import type { SendStatus } from "./sends";
import type { SubscriberStatus } from "./subscribers";

export interface SeedSubscriber {
  id: string;
  email: string;
  status: SubscriberStatus;
  confirm_token: string;
  unsub_token: string;
  created_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
}

export interface SeedSuppression {
  email: string;
  reason: string;
  detail: string | null;
  created_at: number;
}

export interface SeedPost {
  id: string;
  slug: string;
  subject: string;
  status: PostStatus;
  current_revision: string | null;
  created_at: number;
  updated_at: number;
}

export interface SeedRevision {
  id: string;
  post_id: string;
  markdown: string;
  metadata: string;
  author: string | null;
  created_at: number;
}

export interface SeedImage {
  id: string;
  post_id: string;
  filename: string;
  storage_key: string;
  content_type: string;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface SeedSend {
  id: string;
  post_id: string;
  status: SendStatus;
  fire_at: number;
  rendered_html: string;
  rendered_text: string;
  subject: string;
  recipient_count: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface SeedDelivery {
  id: string;
  send_id: string;
  email: string;
  status: string;
  provider_id: string | null;
  error: string | null;
  attempts: number;
  updated_at: number;
  event: string | null;
  event_detail: string | null;
  event_at: number | null;
}

/** Split into chunks small enough to stay well under D1's per-batch bind limit. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Delete every row, in FK-safe order (children before parents). Idempotent.
 *
 * Includes the `settings` singleton, so a reset — or a re-seed — starts from a clean
 * settings row rather than merging the demo's identity onto stale operator config. That
 * matters for determinism: without it, a template or logo saved before a schema/token
 * change (e.g. a pre-`email.*` template still using `footer.*`) would survive a re-seed,
 * because the seed's `updateSettings` merges rather than replaces. Settings live in D1;
 * the branding logo's R2 bytes are the caller's to clear (see the dev reset route).
 */
export async function resetAll(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM deliveries"),
    db.prepare("DELETE FROM sends"),
    db.prepare("DELETE FROM images"),
    db.prepare("DELETE FROM post_revisions"),
    db.prepare("DELETE FROM posts"),
    db.prepare("DELETE FROM suppressions"),
    db.prepare("DELETE FROM subscribers"),
    db.prepare("DELETE FROM settings"),
  ]);
}

export async function insertSubscribers(db: D1Database, rows: SeedSubscriber[]): Promise<void> {
  for (const group of chunk(rows, 25)) {
    await db.batch(
      group.map((r) =>
        db
          .prepare(
            "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            r.id,
            r.email,
            r.status,
            r.confirm_token,
            r.unsub_token,
            r.created_at,
            r.confirmed_at,
            r.unsubscribed_at,
          ),
      ),
    );
  }
}

export async function insertSuppressions(db: D1Database, rows: SeedSuppression[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db.batch(
    rows.map((r) =>
      db
        .prepare("INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?)")
        .bind(r.email, r.reason, r.detail, r.created_at),
    ),
  );
}

/** Insert a post and its (single) revision atomically, mirroring createPost. */
export async function insertPost(
  db: D1Database,
  post: SeedPost,
  revision: SeedRevision,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO posts (id, slug, subject, status, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        post.id,
        post.slug,
        post.subject,
        post.status,
        post.current_revision,
        post.created_at,
        post.updated_at,
      ),
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        revision.id,
        revision.post_id,
        revision.markdown,
        revision.metadata,
        revision.author,
        revision.created_at,
      ),
  ]);
}

export async function insertImage(db: D1Database, row: SeedImage): Promise<void> {
  await db
    .prepare(
      "INSERT INTO images (id, post_id, filename, storage_key, content_type, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.id,
      row.post_id,
      row.filename,
      row.storage_key,
      row.content_type,
      row.width,
      row.height,
      row.created_at,
    )
    .run();
}

export async function insertSend(db: D1Database, row: SeedSend): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sends
         (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, locked_until, scheduled_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.post_id,
      row.status,
      row.fire_at,
      row.rendered_html,
      row.rendered_text,
      row.subject,
      row.recipient_count,
      row.scheduled_at,
      row.started_at,
      row.completed_at,
    )
    .run();
}

export async function insertDeliveries(db: D1Database, rows: SeedDelivery[]): Promise<void> {
  for (const group of chunk(rows, 25)) {
    await db.batch(
      group.map((r) =>
        db
          .prepare(
            `INSERT INTO deliveries
               (id, send_id, email, status, provider_id, error, attempts, updated_at, event, event_detail, event_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.id,
            r.send_id,
            r.email,
            r.status,
            r.provider_id,
            r.error,
            r.attempts,
            r.updated_at,
            r.event,
            r.event_detail,
            r.event_at,
          ),
      ),
    );
  }
}
