/** Post + revision queries. Every save writes a full-text revision (spec §4). */

import type { Post, PostListItem, PostStatus } from "../../shared/posts";
import { EMPTY_SUBJECT_SLUG, slugify } from "../../shared/slug";
import { newId } from "../lib/ids";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { unwrap } from "../lib/unwrap";
import { stampSendsOfPostStmt, tombstoneSendsStmt } from "./sends";

// The row shapes live in shared/ so the editor reads the same definitions; the names here
// are the Worker's own.
export type { PostStatus };
export type PostRow = Post;

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
  slug_auto?: boolean;
  markdown?: string;
}

// SQLite has no boolean: `slug_auto` and `email_only` are stored as 0 or 1, and every read
// turns them back into the wire's booleans here, so nothing above this module sees the integer.
type Stored<T extends Post> = Omit<T, "slug_auto" | "email_only"> & {
  slug_auto: number;
  email_only: number;
};

function fromStored<T extends Post>(row: Stored<T>): T {
  return {
    ...row,
    slug_auto: row.slug_auto === 1,
    email_only: row.email_only === 1,
  } as T;
}

/**
 * Move a post between lifecycle states by compare-and-swap, as a statement so the
 * freeze can batch the lock with its send insert. `guard` (the settings-version
 * predicate the insert carries) keeps the two in step: neither lands without the other.
 */
export function setPostStatusStmt(
  db: D1Database,
  postId: string,
  from: PostStatus,
  to: PostStatus,
  now: number,
  guard?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const extra = guard ? ` AND ${guard.sql}` : "";
  return db
    .prepare(`UPDATE posts SET status = ?, updated_at = ? WHERE id = ? AND status = ?${extra}`)
    .bind(to, now, postId, from, ...(guard?.binds ?? []));
}

/** The slug a post's subject gives it: slugified, or `post` when nothing usable remains. */
function slugOf(text: string): string {
  return slugify(text) || EMPTY_SUBJECT_SLUG;
}

/** The longest slug a post may have, as the subject's derivation caps it. */
const SLUG_MAX = 80;

/** Whether a slug set by hand is well formed (SPEC §4): lowercase letters and numbers, in
 *  words joined by single hyphens, and no longer than a derived slug may be. */
export function slugWellFormed(slug: string): boolean {
  return slug.length <= SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/** A change to a post's slug: set by hand (`slug`), or following the subject (`slugAuto`). */
export interface SlugChange {
  slug?: string;
  slugAuto?: boolean;
}

/** Why a slug change was refused: the slug set by hand isn't well formed, or another post holds
 *  it. The caller turns it into the refusal the API names. */
export type SlugRefusal = "slug_invalid" | "slug_taken";

/** A save's slug refused, thrown so the save's caller answers it as the API names it. */
export class SlugRefused extends Error {
  constructor(readonly code: SlugRefusal) {
    super(code);
    this.name = "SlugRefused";
  }
}

/** The slug a post will have after a change, or why it can't (SPEC §4). */
export type SlugResult = { slug: string; auto: boolean } | { refused: SlugRefusal };

/**
 * Work out a post's slug after a change, against every other post (`postId`, absent for a new
 * one). A slug set by hand must be well formed and no other post's, or it is refused. A slug
 * that follows the subject takes the subject's slug when it is free, and when another post
 * holds it, the first free number after it (`spring-update-2`, `slug_taken` says why). A post
 * already on a number of the subject's slug keeps it, so a save never moves it to another.
 */
export async function resolveSlug(
  db: D1Database,
  current: { postId?: string; slug?: string; slugAuto: boolean; subject: string },
  change: SlugChange,
): Promise<SlugResult> {
  const auto = change.slugAuto ?? (change.slug === undefined && current.slugAuto);
  if (!auto) {
    const slug = change.slug ?? current.slug ?? slugOf(current.subject);
    if (change.slug !== undefined) {
      if (!slugWellFormed(slug)) {
        return { refused: "slug_invalid" };
      }
      if (await slugTaken(db, slug, current.postId)) {
        return { refused: "slug_taken" };
      }
    }
    return { slug, auto: false };
  }
  const wanted = slugOf(current.subject);
  if (!(await slugTaken(db, wanted, current.postId))) {
    return { slug: wanted, auto: true };
  }
  if (current.slug && isNumberOf(current.slug, wanted)) {
    return { slug: current.slug, auto: true };
  }
  return { slug: await uniqueSlug(db, wanted, current.postId), auto: true };
}

/** Whether `slug` is `base` with a number after it, as `uniqueSlug` makes (`base-2`). */
function isNumberOf(slug: string, base: string): boolean {
  return slug.startsWith(`${base}-`) && /^[1-9][0-9]*$/.test(slug.slice(base.length + 1));
}

/**
 * When a post's slug follows its subject but another post holds the subject's slug, that slug
 * (`SlugTaken`), so a client can say why the address didn't follow and ask for another. Null
 * when the slug is set by hand, follows freely, or the subject gives no slug of its own.
 */
export async function slugTakenFor(db: D1Database, post: PostRow): Promise<string | null> {
  const wanted = slugify(post.subject);
  if (!post.slug_auto || !wanted || wanted === post.slug) {
    return null;
  }
  return (await slugTaken(db, wanted, post.id)) ? wanted : null;
}

/** Whether a failed write was refused by the unique index on slugs: another post took the slug
 *  between the check and the write. */
export function isSlugCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:\s*posts\.slug/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/** A change to a post's settings (SPEC §4, §5): any subset, as `ListingBody`, its slug already
 *  resolved (`resolveSlug`). */
export interface PublishingInput {
  emailOnly?: boolean;
  slug?: { slug: string; auto: boolean };
}

/**
 * The statement that sets a post's listing and slug, so a freeze can batch it with the lock it
 * lands beside (`guard`, as for `setPostStatusStmt`). Never touches `updated_at`: the settings
 * are not an edit, so the post keeps its place in the Drafts list.
 */
export function setPublishingStmt(
  db: D1Database,
  post: PostRow,
  input: PublishingInput,
  guard?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const extra = guard ? ` AND ${guard.sql}` : "";
  return db
    .prepare(`UPDATE posts SET email_only = ?, slug = ?, slug_auto = ? WHERE id = ?${extra}`)
    .bind(
      (input.emailOnly ?? post.email_only) ? 1 : 0,
      input.slug?.slug ?? post.slug,
      (input.slug?.auto ?? post.slug_auto) ? 1 : 0,
      post.id,
      ...(guard?.binds ?? []),
    );
}

/** Whether a settings change changes anything about the post. */
export function publishingChanges(post: PostRow, input: PublishingInput): boolean {
  return (
    (input.emailOnly !== undefined && input.emailOnly !== post.email_only) ||
    (input.slug !== undefined &&
      (input.slug.slug !== post.slug || input.slug.auto !== post.slug_auto))
  );
}

/**
 * Change a post's settings, its listing and its archive address, in whatever state it is: none
 * is part of the frozen email (I3). Answers whether anything changed, so a repeat of the same
 * choice writes nothing. Each of the post's sends carries the settings on its view, so the same
 * batch gives them a new `rev` and a client following sends sees the change (SPEC §8). The
 * caller has resolved the slug and refused a change to a published post's.
 */
export async function setPublishing(
  db: D1Database,
  post: PostRow,
  input: PublishingInput,
): Promise<boolean> {
  if (!publishingChanges(post, input)) {
    return false;
  }
  await db.batch([setPublishingStmt(db, post, input), stampSendsOfPostStmt(db, post.id)]);
  return true;
}

export async function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE id = ?")
    .bind(id)
    .first<Stored<PostRow>>();
  return row && fromStored(row);
}

/** The post whose archive address is `slug`, if any. */
export async function getBySlug(db: D1Database, slug: string): Promise<PostRow | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE slug = ?")
    .bind(slug)
    .first<Stored<PostRow>>();
  return row && fromStored(row);
}

/** The post an unlisted link names (SPEC §5). */
export async function getByUnlistedToken(db: D1Database, token: string): Promise<PostRow | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE unlisted_token = ?")
    .bind(token)
    .first<Stored<PostRow>>();
  return row && fromStored(row);
}

export type PostListRow = PostListItem;

/** Narrow the post list by `status` (one status, or a set — the Drafts view passes
 *  `['draft','scheduled']`) and a subject contains-search. */
export interface PostFilter {
  status?: PostStatus | PostStatus[];
  search?: string;
}

/** The sortable columns exposed by `GET /api/posts` (see `parseListParams`). */
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
    where.push("p.status IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(statuses));
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
  // send id and status (a post has at most one active send, enforced by `idx_sends_one_active_per_post`, so the join
  // is 1:1). The scheduled-first default sort keys on that fire time.
  const { results } = await db
    .prepare(
      `SELECT p.*, s.fire_at AS fire_at, s.id AS active_send_id, s.status AS active_send_status, cr.author AS author
         FROM posts p
         LEFT JOIN sends s ON s.post_id = p.id AND s.status IN ('scheduled', 'sending')
         LEFT JOIN post_revisions cr ON cr.id = p.current_revision
         ${clause}
         ${order}
         LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<Stored<PostListRow>>();
  return results.map(fromStored);
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

// Every post holds its slug, drafts included (SPEC §4).
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

/** Return `base`, or `base-2`, `base-3`, … until no other post holds it. Only a new post that
 *  follows its subject is numbered, since it has no slug of its own to keep. */
async function uniqueSlug(db: D1Database, base: string, exceptId?: string): Promise<string> {
  const root = base || EMPTY_SUBJECT_SLUG;
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

/**
 * Create a draft post and its first revision (the create is the first save). A create follows
 * the subject unless it names a slug; `slug_auto: false` alone takes the subject's slug once
 * and keeps it. A slug it names that can't be set is thrown as `SlugRefused` (`resolveSlug`).
 */
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
  const resolved = await resolveSlug(
    db,
    { slugAuto: input.slug === undefined, subject },
    { slug: input.slug, slugAuto: input.slug_auto },
  );
  if ("refused" in resolved) {
    throw new SlugRefused(resolved.refused);
  }
  const { slug, auto } = resolved;
  const metadata = JSON.stringify({ subject, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO posts (id, slug, slug_auto, subject, status, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      )
      .bind(id, slug, auto ? 1 : 0, subject, revId, now, now),
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
 * checks status first; the WHERE guard is a backstop). A slug that follows the
 * subject is derived afresh on every save, so it tracks subject edits, unless another post
 * holds the subject's slug; a slug set by hand changes only when a save names a new one, and
 * is thrown as `SlugRefused` when malformed or another post's (`resolveSlug`). Sending a slug
 * sets it by hand.
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
  const resolved = await resolveSlug(
    db,
    { postId: post.id, slug: post.slug, slugAuto: post.slug_auto, subject },
    { slug: input.slug, slugAuto: input.slug_auto },
  );
  if ("refused" in resolved) {
    throw new SlugRefused(resolved.refused);
  }
  const { slug, auto } = resolved;
  const metadata = JSON.stringify({ subject, slug });

  await db.batch([
    db
      .prepare(
        "INSERT INTO post_revisions (id, post_id, markdown, metadata, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(revId, post.id, markdown, metadata, author, now),
    db
      .prepare(
        "UPDATE posts SET slug = ?, slug_auto = ?, subject = ?, current_revision = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
      )
      .bind(slug, auto ? 1 : 0, subject, revId, now, post.id),
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
 * any sends (with their deliveries and notifications) left from prior scheduling. Children are
 * deleted first so the schema's FKs hold. Callers guard this to drafts (see
 * `requireDraft`), and a post is only a draft with no sent post behind it: a
 * scheduled or sent post can't reach here, so the only sends present are the
 * `canceled` ones a cancel leaves behind — a sent post's record is never
 * deleted. R2 image objects are deleted by the caller.
 */
export async function deletePost(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM deliveries WHERE send_id IN (SELECT id FROM sends WHERE post_id = ?)")
      .bind(id),
    db
      .prepare(
        "DELETE FROM notifications WHERE send_id IN (SELECT id FROM sends WHERE post_id = ?)",
      )
      .bind(id),
    tombstoneSendsStmt(db, "post_id = ?", id),
    db.prepare("DELETE FROM sends WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM images WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM post_revisions WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
}
