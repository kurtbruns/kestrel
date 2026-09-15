/** Post + revision queries. Every save writes a full-text revision (spec §4). */
import { newId } from "../lib/ids";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { slugify } from "../lib/slug";
import { unwrap } from "../lib/unwrap";

export type PostStatus = "draft" | "scheduled" | "sent";

export interface PostRow {
  id: string;
  slug: string;
  subject: string;
  status: PostStatus;
  current_revision: string | null;
  created_at: number;
  updated_at: number;
}

export interface RevisionRow {
  id: string;
  post_id: string;
  markdown: string;
  metadata: string; // JSON: { subject, slug }
  author: string | null;
  created_at: number;
}

export interface PostInput {
  subject?: string;
  slug?: string;
  markdown?: string;
}

export function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
}

export function getBySlug(db: D1Database, slug: string): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE slug = ?").bind(slug).first<PostRow>();
}

/** A post plus its active send, if any. `fire_at` is the send's fire time; `active_send_*`
 *  identify it and — crucially — carry its status, so a post whose send is in flight
 *  (`sending`) can be told apart from one still merely `scheduled` even though the post's
 *  own status is `scheduled` for both until the send completes (SPEC §6). */
export interface PostListRow extends PostRow {
  fire_at: number | null;
  active_send_id: string | null;
  active_send_status: "scheduled" | "sending" | null;
}

/** Narrow the post list by `status` (one status, or a set — the Drafts view passes
 *  `['draft','scheduled']`) and a subject contains-search. */
export interface PostFilter {
  status?: PostStatus | PostStatus[];
  search?: string;
}

/** The sortable columns exposed by `GET /posts` (see `parseListParams`). */
export const POST_LIST_SPEC: ListSpec = {
  columns: {
    updated: "p.updated_at",
    title: "p.subject",
    status: "p.status",
    scheduled: "s.fire_at",
  },
  defaultSort: "updated",
  defaultDir: "desc",
};

// Shared WHERE for the list and its matching count.
function postWhere(filter: PostFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  const statuses = filter.status == null ? [] : ([] as PostStatus[]).concat(filter.status);
  if (statuses.length === 1) {
    where.push("p.status = ?");
    binds.push(statuses[0]);
  } else if (statuses.length > 1) {
    where.push(`p.status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }
  const term = filter.search?.trim().toLowerCase();
  if (term) {
    where.push("LOWER(p.subject) LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/** One page of posts. With no explicit sort, keeps the bespoke default — scheduled
 *  posts first (soonest fire time), then the rest by most-recently edited — until the
 *  reader picks a column. Omit `page` for that default order, unpaginated. */
export async function listPosts(
  db: D1Database,
  filter: PostFilter = {},
  page?: ListParams,
): Promise<PostListRow[]> {
  const { clause, binds } = postWhere(filter);
  const order =
    page?.sortExplicit === true
      ? orderByClause(page, "p.id")
      : "ORDER BY (s.fire_at IS NULL) ASC, s.fire_at ASC, p.updated_at DESC, p.id DESC";
  const limit = page ? page.limit : -1; // -1 = SQLite "no limit"
  const offset = page ? page.offset : 0;
  // Join the post's ACTIVE send — scheduled OR sending — so an in-flight post carries its
  // send id and status (a post has at most one active send, migration 0004, so the join
  // is 1:1). The scheduled-first default sort keys on that fire time.
  const { results } = await db
    .prepare(
      `SELECT p.*, s.fire_at AS fire_at, s.id AS active_send_id, s.status AS active_send_status
         FROM posts p
         LEFT JOIN sends s ON s.post_id = p.id AND s.status IN ('scheduled', 'sending')
         ${clause}
         ${order}
         LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<PostListRow>();
  return results;
}

/** How many posts match `filter` — the `page.total` for the post list. */
export async function countPosts(db: D1Database, filter: PostFilter = {}): Promise<number> {
  const { clause, binds } = postWhere(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM posts p ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function slugTaken(db: D1Database, slug: string, exceptId?: string): Promise<boolean> {
  const sql = exceptId
    ? "SELECT 1 FROM posts WHERE slug = ? AND id != ? LIMIT 1"
    : "SELECT 1 FROM posts WHERE slug = ? LIMIT 1";
  const bind = exceptId ? [slug, exceptId] : [slug];
  const row = await db
    .prepare(sql)
    .bind(...bind)
    .first();
  return row !== null;
}

/** Return `base`, or `base-2`, `base-3`, … until one is free. */
export async function uniqueSlug(db: D1Database, base: string, exceptId?: string): Promise<string> {
  const root = base || "post";
  let candidate = root;
  let n = 1;
  while (await slugTaken(db, candidate, exceptId)) {
    n += 1;
    candidate = `${root}-${n}`;
  }
  return candidate;
}

export function getCurrentRevision(db: D1Database, post: PostRow): Promise<RevisionRow | null> {
  if (!post.current_revision) {
    return Promise.resolve(null);
  }
  return db
    .prepare("SELECT * FROM post_revisions WHERE id = ?")
    .bind(post.current_revision)
    .first<RevisionRow>();
}

export async function listRevisions(db: D1Database, postId: string): Promise<RevisionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM post_revisions WHERE post_id = ? ORDER BY rowid ASC")
    .bind(postId)
    .all<RevisionRow>();
  return results;
}

/** 1-based revision by chronological (insertion) order. */
export function getRevisionByIndex(
  db: D1Database,
  postId: string,
  n: number,
): Promise<RevisionRow | null> {
  if (!Number.isInteger(n) || n < 1) {
    return Promise.resolve(null);
  }
  return db
    .prepare("SELECT * FROM post_revisions WHERE post_id = ? ORDER BY rowid ASC LIMIT 1 OFFSET ?")
    .bind(postId, n - 1)
    .first<RevisionRow>();
}

/** Create a draft post and its first revision (the create is the first save). */
export async function createPost(
  db: D1Database,
  input: PostInput,
  author: string | null,
): Promise<{ post: PostRow; revision: RevisionRow }> {
  const now = Date.now();
  const id = newId();
  const revId = newId();
  const subject = input.subject ?? "";
  const markdown = input.markdown ?? "";
  const slug = await uniqueSlug(db, slugify(input.slug ?? subject));
  const metadata = JSON.stringify({ subject, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO posts (id, slug, subject, status, current_revision, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)",
      )
      .bind(id, slug, subject, revId, now, now),
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(revId, id, markdown, metadata, author, now),
  ]);

  const post = unwrap(await getPost(db, id), "post");
  const revision = unwrap(
    await db.prepare("SELECT * FROM post_revisions WHERE id = ?").bind(revId).first<RevisionRow>(),
    "revision",
  );
  return { post, revision };
}

/**
 * Write a new revision and advance `current_revision`. Draft-only (the caller
 * checks status first; the WHERE guard is a backstop). The slug stays stable
 * unless explicitly overridden, so archive links don't break on a subject edit.
 */
export async function updatePost(
  db: D1Database,
  post: PostRow,
  input: PostInput,
  author: string | null,
): Promise<{ post: PostRow; revision: RevisionRow }> {
  const current = await getCurrentRevision(db, post);
  const now = Date.now();
  const revId = newId();
  const subject = input.subject ?? post.subject;
  const markdown = input.markdown ?? current?.markdown ?? "";
  let slug = post.slug;
  if (input.slug !== undefined) {
    slug = await uniqueSlug(db, slugify(input.slug), post.id);
  }
  const metadata = JSON.stringify({ subject, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(revId, post.id, markdown, metadata, author, now),
    db
      .prepare(
        "UPDATE posts SET slug = ?, subject = ?, current_revision = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
      )
      .bind(slug, subject, revId, now, post.id),
  ]);

  const updated = unwrap(await getPost(db, post.id), "post");
  const revision = unwrap(
    await db.prepare("SELECT * FROM post_revisions WHERE id = ?").bind(revId).first<RevisionRow>(),
    "revision",
  );
  return { post: updated, revision };
}

/**
 * Delete a post and everything that references it — revisions, image rows, and
 * any sends (with their deliveries) left from prior scheduling. Children are
 * deleted first so the schema's FKs hold. Callers guard this to drafts (see
 * `requireDraft`), and a post is only a draft with no sent issue behind it: a
 * scheduled or sent post can't reach here, so the only sends present are the
 * `canceled` ones a cancel leaves behind — a sent issue's record is never
 * deleted. R2 image objects are deleted by the caller.
 */
export async function deletePost(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM deliveries WHERE send_id IN (SELECT id FROM sends WHERE post_id = ?)")
      .bind(id),
    db.prepare("DELETE FROM sends WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM images WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM post_revisions WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
}
