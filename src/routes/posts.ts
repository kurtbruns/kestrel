/** Post CRUD + revision history. All routes are authed (admin surface). */
import type { RequestContext } from "../router";
import { param } from "../router";
import { badRequest, conflict, json, notFound } from "../lib/errors";
import * as posts from "../db/posts";
import * as images from "../db/images";

function author(c: RequestContext): string | null {
  return c.principal?.email ?? c.principal?.kind ?? null;
}

async function readBody(c: RequestContext): Promise<posts.PostInput> {
  const ct = c.req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return {};
  try {
    const raw = (await c.req.json()) as Record<string, unknown>;
    const pick = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    return {
      title: pick("title"),
      subject: pick("subject"),
      preheader: pick("preheader"),
      slug: pick("slug"),
      markdown: pick("markdown"),
    };
  } catch {
    throw badRequest("invalid JSON body");
  }
}

async function requireDraft(c: RequestContext): Promise<posts.PostRow> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) throw notFound("post");
  if (post.status !== "draft") {
    throw conflict("post is not a draft — cancel the schedule to edit");
  }
  return post;
}

export async function createPost(c: RequestContext): Promise<Response> {
  const input = await readBody(c);
  const { post, revision } = await posts.createPost(c.env.DB, input, author(c));
  return json({ post, revision_id: revision.id }, 201);
}

export async function listPosts(c: RequestContext): Promise<Response> {
  return json({ posts: await posts.listPosts(c.env.DB) });
}

export async function getPost(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) throw notFound("post");
  const revision = await posts.getCurrentRevision(c.env.DB, post);
  return json({ post, markdown: revision?.markdown ?? "" });
}

export async function updatePost(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const input = await readBody(c);
  const { post: updated, revision } = await posts.updatePost(c.env.DB, post, input, author(c));
  return json({ post: updated, revision_id: revision.id });
}

export async function deletePost(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const imgs = await images.listImages(c.env.DB, post.id);
  await Promise.all(imgs.map((i) => c.env.MEDIA.delete(i.storage_key)));
  await posts.deletePost(c.env.DB, post.id);
  return json({ deleted: true });
}

export async function listRevisions(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) throw notFound("post");
  const revs = await posts.listRevisions(c.env.DB, post.id);
  return json({
    revisions: revs.map((r, i) => ({
      n: i + 1,
      id: r.id,
      author: r.author,
      created_at: r.created_at,
      is_current: r.id === post.current_revision,
      metadata: JSON.parse(r.metadata),
    })),
  });
}

export async function getRevision(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) throw notFound("post");
  const n = Number(param(c, "n"));
  if (!Number.isInteger(n) || n < 1) throw badRequest("revision index must be a positive integer");
  const rev = await posts.getRevisionByIndex(c.env.DB, post.id, n);
  if (!rev) throw notFound("revision");
  return json({
    n,
    id: rev.id,
    author: rev.author,
    created_at: rev.created_at,
    markdown: rev.markdown,
    metadata: JSON.parse(rev.metadata),
  });
}
