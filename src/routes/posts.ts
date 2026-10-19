/** Post CRUD + revision history. All routes are authed (admin surface). */

import { encodeSendCursor } from "../../shared/cursor";
import type {
  BaseRequiredError,
  PostListResponse,
  PostResponse,
  PostSavedResponse,
  PostSettingsResponse,
  RevisionListResponse,
  RevisionResponse,
  StaleRevisionError,
} from "../../shared/posts";
import * as images from "../db/images";
import * as posts from "../db/posts";
import { currentSendSeq, getActiveSendForPost } from "../db/sends";
import { fieldError, optBoolean, optString, optStringOrNull, readJsonObject } from "../lib/body";
import { badRequest, json, notFound, refusal } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { slugRefusal } from "../lib/slug_refusals";
import { unwrap } from "../lib/unwrap";
import type { RequestContext } from "../router";
import { param } from "../router";
import { carryingPost, viewPost, viewPosts } from "../services/post_view";
import { applySettings, readSettingsBody, resolveSettings } from "./post_settings";

/** Who is saving: a person's email or `service`, and the client a person came through. */
function authorship(c: RequestContext): [author: string | null, client: string | null] {
  return [c.principal?.email ?? c.principal?.kind ?? null, c.principal?.client ?? null];
}

/** The parsed edit payload, plus the optional base revision for the concurrency check. */
interface EditBody {
  input: posts.PostInput;
  base_revision: string | null;
}

/**
 * Read an edit body. Every field is optional, and one that is present must be a
 * string (`slug_auto` a boolean): a wrong type is a 400 naming it, never dropped, so a
 * save can't report success for a field it ignored. `base_revision` also takes `null` ("no base", which
 * `updatePost` refuses), and nothing else, so a malformed one is named as the field at
 * fault rather than answered as a missing base.
 */
async function readBody(c: RequestContext, opts: { optional?: boolean } = {}): Promise<EditBody> {
  const raw = await readJsonObject(c, opts);
  const slug = optString(raw, "slug");
  const slugAuto = optBoolean(raw, "slug_auto");
  if (slug !== undefined && slugAuto === true) {
    // A slug that follows the subject has none of its own to take; honoring either would
    // quietly drop the other.
    throw fieldError("slug", "slug cannot be set while slug_auto is true");
  }
  return {
    input: {
      subject: optString(raw, "subject"),
      slug,
      slug_auto: slugAuto,
      markdown: optString(raw, "markdown"),
    },
    base_revision: optStringOrNull(raw, "base_revision") ?? null,
  };
}

/**
 * The revision the client believes it is editing, for optimistic concurrency
 * (see `updatePost`). Accepted as an `If-Match` header (idiomatic, matches the
 * `ETag` we emit) or a `base_revision` body field; the header wins. `*` and a
 * missing value both mean "no base", which `updatePost` refuses: `*` would be an
 * explicit last-write-wins, and no client gets to overwrite another writer's edit.
 */
function baseRevision(c: RequestContext, body: EditBody): string | null {
  const header = c.req.headers.get("If-Match");
  if (header && header !== "*") {
    return header.replace(/^"(.*)"$/, "$1");
  }
  return body.base_revision;
}

/** A post as the API answers it, in any state, on every route (`viewPost`). */
function answered(c: RequestContext, post: posts.PostRow) {
  return viewPost(c.env, c.config, post);
}

/** Expose a post's current revision as an ETag so a client can send it back as `If-Match`. */
function revisionHeaders(post: posts.PostRow): HeadersInit | undefined {
  return post.current_revision ? { ETag: `"${post.current_revision}"` } : undefined;
}

/**
 * The post the request names, refused unless it is a draft: a scheduled post's content is
 * frozen until its schedule is canceled (I3), and a sent one's for good. A post stays
 * `scheduled` until its send completes, so one whose send has started can't be canceled
 * back to a draft either, and the refusal says which it is, carrying the post as it stands.
 * Saving a post, deleting it, and changing its images all pass through here.
 */
export async function requireDraft(c: RequestContext): Promise<posts.PostRow> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  if (post.status === "sent") {
    throw refusal("post_not_draft", "This post has been sent, so it can’t be changed.", {
      post: await answered(c, post),
    });
  }
  if (post.status !== "draft") {
    const active = await getActiveSendForPost(c.env.DB, post.id);
    throw refusal(
      "post_not_draft",
      active?.status === "sending"
        ? "This post is being sent, so it can’t be changed."
        : "This post is scheduled, so it’s locked. Cancel the schedule to edit it.",
      { post: await answered(c, post) },
    );
  }
  return post;
}

export async function createPost(c: RequestContext): Promise<Response> {
  // A create with an empty body, which needs no content type, is the "new blank draft"
  // case; one that sends a body is held to the same JSON and field rules as an edit.
  const { input } = await readBody(c, { optional: true });
  const { post, revision } = await slugGuarded(input, () =>
    posts.createPost(c.env.DB, input, ...authorship(c)),
  );
  const body: PostSavedResponse = {
    post: await answered(c, post),
    subject_slug_held: await posts.subjectSlugHeld(c.env.DB, post),
    revision_id: revision.id,
  };
  return json(body, 201, revisionHeaders(post));
}

/** The `status` query param: one status, or a comma list (`draft,scheduled`, which the
 *  Drafts view sends). The router has held each to `POST_STATUSES`; absent, no filter. */
function parseStatusFilter(raw: string | null): posts.PostStatus | posts.PostStatus[] | undefined {
  if (raw === null) {
    return undefined;
  }
  const list = [...new Set(raw.split(",").map((s) => s.trim() as posts.PostStatus))];
  return list.length === 1 ? list[0] : list;
}

export async function listPosts(c: RequestContext): Promise<Response> {
  const status = parseStatusFilter(c.url.searchParams.get("status"));
  const search = c.url.searchParams.get("search") ?? undefined;
  const filter = { status, search } satisfies posts.PostFilter;
  const page = parseListParams(c.url, posts.POST_LIST_SPEC);
  // The send sequence and its time come first, so whatever the rows show of their sends is
  // at or after the cursor, and a client following them from here misses nothing.
  const now = Date.now();
  const seq = await currentSendSeq(c.env.DB);
  const [total, rows] = await Promise.all([
    posts.countPosts(c.env.DB, filter),
    posts.listPosts(c.env.DB, filter, page),
  ]);
  const body: PostListResponse = {
    posts: await viewPosts(c.env, c.config, rows),
    page: listPage(total, page),
    cursor: encodeSendCursor({ seq, at: now }),
  };
  return json(body);
}

export async function getPost(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const revision = await posts.getCurrentRevision(c.env.DB, post);
  // Where its send stands rides on the post (`send`): a scheduled one locks the editor, one
  // going out or sent sends the editor to its watch or record instead.
  const body: PostResponse = {
    post: await answered(c, post),
    subject_slug_held: await posts.subjectSlugHeld(c.env.DB, post),
    markdown: revision?.markdown ?? "",
  };
  return json(body, 200, revisionHeaders(post));
}

/**
 * Optimistic concurrency (SPEC §4): the client sends the revision it loaded (via
 * `If-Match`/`base_revision`), and if another save has advanced the post since, the
 * save is rejected with 409 carrying the newer revision instead of clobbering it — so
 * a stale tab, or a stale Claude edit, learns its view is out of date rather than
 * silently overwriting the other writer. A save with no base is refused with 428 and
 * the post as it stands, so leaving the base out can't be a way around the check.
 */
export async function updatePost(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const body = await readBody(c);
  const base = baseRevision(c, body);
  if (!base) {
    const required: BaseRequiredError = {
      error: "base_required",
      message:
        "A save must name the revision it was based on. Read the post, then save with its current_revision as base_revision or If-Match.",
      field: "base_revision",
      post: await answered(c, post),
    };
    return json(required, 428, revisionHeaders(post));
  }
  if (post.current_revision && base !== post.current_revision) {
    const current = await posts.getCurrentRevision(c.env.DB, post);
    const stale: StaleRevisionError = {
      error: "stale_revision",
      message: "This draft changed since you loaded it. Read it again before saving.",
      current_revision: post.current_revision,
      updated_at: post.updated_at,
      author: current?.author ?? null,
      author_client: current?.client ?? null,
      post: await answered(c, post),
      markdown: current?.markdown ?? "",
    };
    return json(stale, 409, revisionHeaders(post));
  }
  const { post: updated, revision } = await slugGuarded(body.input, () =>
    posts.updatePost(c.env.DB, post, body.input, ...authorship(c)),
  );
  const saved: PostSavedResponse = {
    post: await answered(c, updated),
    subject_slug_held: await posts.subjectSlugHeld(c.env.DB, updated),
    revision_id: revision.id,
  };
  return json(saved, 200, revisionHeaders(updated));
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
  const body: RevisionListResponse = {
    revisions: revs.map((r, i) => ({
      n: i + 1,
      id: r.id,
      author: r.author,
      author_client: r.client,
      created_at: r.created_at,
      is_current: r.id === post.current_revision,
      metadata: JSON.parse(r.metadata),
    })),
  };
  return json(body);
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
  const body: RevisionResponse = {
    n,
    id: rev.id,
    author: rev.author,
    author_client: rev.client,
    created_at: rev.created_at,
    markdown: rev.markdown,
    metadata: JSON.parse(rev.metadata),
  };
  return json(body);
}

/** How many times a write whose slug the server chose runs before a collision is refused. */
const SLUG_ATTEMPTS = 3;

/**
 * Run a write that sets a slug, answering a slug it refused as the API's refusal. Another post
 * can take the slug between the write's check and the write itself (the unique index refuses
 * it). A slug the request set by hand is then refused as taken; one the server chose (SPEC §4)
 * is chosen again, since the request never named it: each run resolves the slug afresh, and
 * a refused batch wrote nothing.
 */
async function slugGuarded<T>(input: posts.PostInput, write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (err instanceof posts.SlugRefused) {
        throw slugRefusal(err.code);
      }
      if (posts.isSlugCollision(err)) {
        if (input.slug === undefined && attempt < SLUG_ATTEMPTS) {
          continue;
        }
        throw slugRefusal("slug_taken");
      }
      throw err;
    }
  }
}

/**
 * Change a post's settings (SPEC §4, §5): its listing, in the archive or email only, and its
 * archive address. Any state, a sent post's included, since none is part of the frozen copy
 * (I3); a repeat of what the post already has answers `changed: false`. A sent post's address
 * is fixed, and a slug is refused when malformed or another post's (`resolveSettings`).
 */
export async function setSettings(c: RequestContext): Promise<Response> {
  const fields = readSettingsBody(await readJsonObject(c));
  if (
    fields.emailOnly === undefined &&
    fields.slug === undefined &&
    fields.slugAuto === undefined
  ) {
    throw fieldError(
      "email_only",
      "Name what to change: email_only (true for email only, false to list the post in the archive), slug, or slug_auto",
    );
  }
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const changed = await carryingPost(c.env, c.config, post.id, async () =>
    applySettings(c.env.DB, post, fields, await resolveSettings(c.env.DB, post, fields)),
  );
  const now = changed ? unwrap(await posts.getPost(c.env.DB, post.id), "post") : post;
  const answer: PostSettingsResponse = {
    post: await answered(c, now),
    subject_slug_held: await posts.subjectSlugHeld(c.env.DB, now),
    changed,
  };
  return json(answer);
}
