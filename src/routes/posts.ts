/** Post CRUD + revision history. All routes are authed (admin surface). */

import * as images from "../db/images";
import * as posts from "../db/posts";
import { getActiveSendForPost, latestSentSendForPost } from "../db/sends";
import { getTemplateRevision, templateRevisionRef } from "../db/template_revisions";
import { badRequest, conflict, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import type { RequestContext } from "../router";
import { param } from "../router";
import { postTemplateFacts } from "../send/schedule";
import { currentTemplateRevision } from "../services/template_history";

function author(c: RequestContext): string | null {
  return c.principal?.email ?? c.principal?.kind ?? null;
}

/** The parsed edit payload, plus the optional base revision for the concurrency check. */
interface EditBody {
  input: posts.PostInput;
  base_revision: string | null;
}

async function readBody(c: RequestContext): Promise<EditBody> {
  const ct = c.req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return { input: {}, base_revision: null };
  }
  try {
    const raw = (await c.req.json()) as Record<string, unknown>;
    const pick = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    return {
      input: { subject: pick("subject"), slug: pick("slug"), markdown: pick("markdown") },
      base_revision: pick("base_revision") ?? null,
    };
  } catch {
    throw badRequest("invalid JSON body");
  }
}

/**
 * The revision the client believes it is editing, for optimistic concurrency
 * (see `updatePost`). Accepted as an `If-Match` header (idiomatic, matches the
 * `ETag` we emit) or a `base_revision` body field; the header wins. `*` and a
 * missing value both mean "no base" — the save then proceeds unchecked.
 */
function baseRevision(c: RequestContext, body: EditBody): string | null {
  const header = c.req.headers.get("If-Match");
  if (header && header !== "*") {
    return header.replace(/^"(.*)"$/, "$1");
  }
  return body.base_revision;
}

/** Expose a post's current revision as an ETag so a client can send it back as `If-Match`. */
function revisionHeaders(post: posts.PostRow): HeadersInit | undefined {
  return post.current_revision ? { ETag: `"${post.current_revision}"` } : undefined;
}

async function requireDraft(c: RequestContext): Promise<posts.PostRow> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  if (post.status !== "draft") {
    throw conflict("post is not a draft — cancel the schedule to edit");
  }
  return post;
}

export async function createPost(c: RequestContext): Promise<Response> {
  const { input } = await readBody(c);
  const { post, revision } = await posts.createPost(c.env.DB, input, author(c));
  return json({ post, revision_id: revision.id }, 201, revisionHeaders(post));
}

const POST_STATUSES: posts.PostStatus[] = ["draft", "scheduled", "sent"];

/** Parse the `status` query param: one status, or a comma list (`draft,scheduled`,
 *  which the Drafts view sends). Unknown values are dropped; empty → no filter. */
function parseStatusFilter(raw: string | null): posts.PostStatus | posts.PostStatus[] | undefined {
  if (!raw) {
    return undefined;
  }
  const seen = new Set<posts.PostStatus>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if ((POST_STATUSES as string[]).includes(s)) {
      seen.add(s as posts.PostStatus);
    }
  }
  const list = [...seen];
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
}

export async function listPosts(c: RequestContext): Promise<Response> {
  const status = parseStatusFilter(c.url.searchParams.get("status"));
  const search = c.url.searchParams.get("search") ?? undefined;
  const filter = { status, search } satisfies posts.PostFilter;
  const page = parseListParams(c.url, posts.POST_LIST_SPEC);
  const [total, rows] = await Promise.all([
    posts.countPosts(c.env.DB, filter),
    posts.listPosts(c.env.DB, filter, page),
  ]);
  // A scheduled post's send may keep an older template than the current one (SPEC §8);
  // the list marks it so the mark and the Update action are never apart. Read the
  // current revision only when a row needs it — the list is polled.
  const current = rows.some((p) => p.active_send_status === "scheduled")
    ? (await currentTemplateRevision(c.env.DB)).id
    : null;
  const marked = rows.map((p) => ({
    ...p,
    template_outdated:
      p.active_send_status === "scheduled" && p.active_send_template_revision !== current,
  }));
  return json({ posts: marked, page: listPage(total, page) });
}

export async function getPost(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const revision = await posts.getCurrentRevision(c.env.DB, post);
  // A post stays `scheduled` while its send is in flight (the post only flips to `sent`
  // on completion), so the active send may be `scheduled` OR `sending`. Split them: a
  // truly-scheduled send drives the editor's soft-lock banner; a `sending` one means the
  // editor should redirect to the live watch instead of opening a locked draft (#162).
  const active = post.status === "scheduled" ? await getActiveSendForPost(c.env.DB, post.id) : null;
  // A sent post no longer opens the editor (#147): the editor uses this send id to
  // redirect to the sent record view (#/sent/:id).
  const sent = post.status === "sent" ? await latestSentSendForPost(c.env.DB, post.id) : null;
  // The template facts (SPEC §6, §9): what is current, what the post was last made
  // with, and whether they differ — the dialog and the API read the same three facts,
  // so neither has to derive the choice.
  const { facts } = await postTemplateFacts(c.env.DB, post.id);
  // The revision the active send was made with.
  const scheduledTemplate =
    active?.status === "scheduled"
      ? await getTemplateRevision(c.env.DB, active.template_revision)
      : null;
  return json(
    {
      post,
      markdown: revision?.markdown ?? "",
      author: revision?.author ?? null, // who wrote the current revision — the freshness poll names them
      scheduled:
        active && active.status === "scheduled"
          ? {
              id: active.id,
              fire_at: active.fire_at,
              template: scheduledTemplate ? templateRevisionRef(scheduledTemplate) : null,
            }
          : null,
      sending: active && active.status === "sending" ? { id: active.id } : null,
      sent: sent ? { id: sent.id } : null,
      template: facts,
    },
    200,
    revisionHeaders(post),
  );
}

/**
 * Optimistic concurrency (SPEC §4): if the client sends the revision it loaded
 * (via `If-Match`/`base_revision`) and another save has advanced the post since,
 * reject with 409 and name the newer revision instead of clobbering it — so a
 * stale tab, or a stale Claude edit, learns its view is out of date rather than
 * silently overwriting the other writer. A save with no base is unchecked
 * (last-write-wins), which keeps older API clients working.
 */
export async function updatePost(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const body = await readBody(c);
  const base = baseRevision(c, body);
  if (base && post.current_revision && base !== post.current_revision) {
    const current = await posts.getCurrentRevision(c.env.DB, post);
    return json(
      {
        error: "stale_revision",
        message: "this draft changed since you loaded it",
        current_revision: post.current_revision,
        updated_at: post.updated_at,
        author: current?.author ?? null,
      },
      409,
      revisionHeaders(post),
    );
  }
  const { post: updated, revision } = await posts.updatePost(c.env.DB, post, body.input, author(c));
  return json({ post: updated, revision_id: revision.id }, 200, revisionHeaders(updated));
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
  if (!post) {
    throw notFound("post");
  }
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
  if (!post) {
    throw notFound("post");
  }
  const n = Number(param(c, "n"));
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest("revision index must be a positive integer");
  }
  const rev = await posts.getRevisionByIndex(c.env.DB, post.id, n);
  if (!rev) {
    throw notFound("revision");
  }
  return json({
    n,
    id: rev.id,
    author: rev.author,
    created_at: rev.created_at,
    markdown: rev.markdown,
    metadata: JSON.parse(rev.metadata),
  });
}
