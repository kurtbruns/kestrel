/** Post + revision queries. Every save writes a full-text revision (spec §4). */
import { newId } from "../lib/ids";
import { slugify } from "../lib/slug";

export type PostStatus = "draft" | "scheduled" | "sent";

export interface PostRow {
  id: string;
  slug: string;
  title: string;
  subject: string;
  preheader: string;
  status: PostStatus;
  current_revision: string | null;
  created_at: number;
  updated_at: number;
}

export interface RevisionRow {
  id: string;
  post_id: string;
  markdown: string;
  metadata: string; // JSON: { title, subject, preheader, slug }
  author: string | null;
  created_at: number;
}

export interface PostInput {
  title?: string;
  subject?: string;
  preheader?: string;
  slug?: string;
  markdown?: string;
}

export function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
}

export function getBySlug(db: D1Database, slug: string): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE slug = ?").bind(slug).first<PostRow>();
}

export async function listPosts(db: D1Database): Promise<PostRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM posts ORDER BY created_at DESC, rowid DESC")
    .all<PostRow>();
  return results;
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
export async function uniqueSlug(
  db: D1Database,
  base: string,
  exceptId?: string,
): Promise<string> {
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
  if (!post.current_revision) return Promise.resolve(null);
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
  if (!Number.isInteger(n) || n < 1) return Promise.resolve(null);
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
  const title = input.title ?? "";
  const subject = input.subject ?? "";
  const preheader = input.preheader ?? "";
  const markdown = input.markdown ?? "";
  const base = slugify(input.slug ?? title);
  const slug = await uniqueSlug(db, base);
  const metadata = JSON.stringify({ title, subject, preheader, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO posts (id, slug, title, subject, preheader, status, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
      )
      .bind(id, slug, title, subject, preheader, revId, now, now),
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(revId, id, markdown, metadata, author, now),
  ]);

  const post = (await getPost(db, id))!;
  const revision = (await db
    .prepare("SELECT * FROM post_revisions WHERE id = ?")
    .bind(revId)
    .first<RevisionRow>())!;
  return { post, revision };
}

/**
 * Write a new revision and advance `current_revision`. Draft-only (the caller
 * checks status first; the WHERE guard is a backstop). The slug stays stable
 * unless explicitly overridden, so archive links don't break on a title edit.
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
  const title = input.title ?? post.title;
  const subject = input.subject ?? post.subject;
  const preheader = input.preheader ?? post.preheader;
  const markdown = input.markdown ?? current?.markdown ?? "";
  let slug = post.slug;
  if (input.slug !== undefined) slug = await uniqueSlug(db, slugify(input.slug), post.id);
  const metadata = JSON.stringify({ title, subject, preheader, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(revId, post.id, markdown, metadata, author, now),
    db
      .prepare(
        "UPDATE posts SET slug = ?, title = ?, subject = ?, preheader = ?, current_revision = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
      )
      .bind(slug, title, subject, preheader, revId, now, post.id),
  ]);

  const updated = (await getPost(db, post.id))!;
  const revision = (await db
    .prepare("SELECT * FROM post_revisions WHERE id = ?")
    .bind(revId)
    .first<RevisionRow>())!;
  return { post: updated, revision };
}

/** Delete a post and its revisions + image rows (R2 objects handled by the caller). */
export async function deletePost(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM images WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM post_revisions WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
}
