// Posts as the API carries them (SPEC §4): the row both clients read, the list row with its
// active send, and the bodies of the post routes. The Worker's routes produce these shapes
// and the editor consumes them; one definition, so neither can drift.

import type { PageMeta } from "./list";

export type PostStatus = "draft" | "scheduled" | "sent";

export interface Post {
  id: string;
  /**
   * The post's archive address, `<archive origin><base path>/<slug>` (SPEC §4): unique among
   * all posts, drafts included, and fixed once the post's send starts.
   */
  slug: string;
  /**
   * Whether the slug follows the subject: derived from it again on every draft save, unless
   * another post holds that slug (`slug_taken`). False once a slug is set by hand.
   */
  slug_auto: boolean;
  /**
   * The post's unlisted link is `<app origin>/email/<unlisted_token>` (SPEC §5): made with the
   * post, never changed, and carried as "view in browser" by every test and send.
   */
  unlisted_token: string;
  subject: string;
  status: PostStatus;
  /**
   * The post's listing (SPEC §5): true when it is email only, mailed as usual but left out of
   * the archive index and the landing page, its archive address answering nothing; false,
   * the default, when it is listed in the archive. Not part of the frozen render, so it can
   * change in any state, a sent post's included (`PUT /api/posts/:id/listing`).
   */
  email_only: boolean;
  /** The current revision's id; the editor carries it on every save (optimistic concurrency). */
  current_revision: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * A post plus its active send, if any. `fire_at` is the send's fire time; `active_send_*`
 * identify it and carry its status, so a post whose send is in flight (`sending`) can be
 * told apart from one still merely `scheduled` even though the post's own status is
 * `scheduled` for both until the send completes (SPEC §6).
 */
export interface PostListItem extends Post {
  fire_at: number | null;
  active_send_id: string | null;
  active_send_status: "scheduled" | "sending" | null;
  /** The current revision's author ("Claude" surfaces as `service`; SPEC §4). */
  author: string | null;
}

/** GET /api/posts */
export interface PostListResponse {
  posts: PostListItem[];
  page: PageMeta;
  /**
   * Where this read stood among the changes to sends (`<seq>.<at>`, as on `GET /api/sends`), to
   * follow the listed posts' sends from with `GET /api/sends/feed`.
   */
  cursor: string;
}

/**
 * When the post's slug follows its subject but another post holds the subject's slug, that
 * slug: the post takes the first free number after it, and a client says why. Null
 * otherwise (SPEC §4).
 */
export type SlugTaken = string | null;

/** GET /api/posts/:id: the post, its current text, and where its send stands. */
export interface PostResponse {
  post: Post;
  slug_taken: SlugTaken;
  markdown: string;
  /** Who wrote the current revision; the freshness poll names them. */
  author: string | null;
  /** The scheduled send that soft-locks this post, and when a template or identity change last re-made it. */
  scheduled: { id: string; fire_at: number; remade_at: number | null } | null;
  /** The send in flight: the editor redirects to the live watch. */
  sending: { id: string } | null;
  /** The send that sent it: the editor redirects to the record. */
  sent: { id: string } | null;
}

/**
 * What POST /api/posts and PUT /api/posts/:id accept: any subset of the fields, and the revision
 * the client loaded, which the server checks before it writes (optimistic concurrency). A PUT
 * must name it, here or as `If-Match`; a create has nothing to be based on.
 */
export interface PostEditBody {
  subject?: string;
  /** A slug set by hand; sending one turns `slug_auto` off. Refused beside `slug_auto: true`. */
  slug?: string;
  /**
   * Have the slug follow the subject (true) or keep it as it stands (false). Absent, a create
   * follows the subject unless it names a slug, and an edit keeps the post's mode.
   */
  slug_auto?: boolean;
  markdown?: string;
  base_revision?: string | null;
}

/** POST /api/posts and PUT /api/posts/:id: the post as saved, and the revision the save wrote. */
export interface PostSavedResponse {
  post: Post;
  slug_taken: SlugTaken;
  revision_id: string;
}

/** GET /api/posts/:id/preview: where the rendered page is, and whether it is a frozen send's copy. */
export interface PreviewResponse {
  url: string;
  subject: string;
  warnings: string[];
  frozen: boolean;
}

/** POST /api/posts/:id/test: one test delivery through the same render as a real send (I5). */
export interface TestSendResponse {
  sent: boolean;
  provider: string;
  to: string;
  subject: string;
  warnings: string[];
  frozen: boolean;
}

/** The 428 a save gets when it names no base revision: the post as it stands, to read and save against. */
export interface BaseRequiredError {
  error: "base_required";
  message: string;
  /** The request field to add, as every refusal about the request names it (docs/API.md). */
  field: "base_revision";
  post: Post;
}

/** The 409 a save gets when its base revision is no longer the newest. */
export interface StaleRevisionError {
  error: "stale_revision";
  message: string;
  current_revision: string | null;
  updated_at: number;
  author: string | null;
}

/**
 * What PUT /api/posts/:id/listing takes: the post's settings (SPEC §4, §5), any subset of them.
 * None is part of the frozen email, so they can change while the post is scheduled, and the
 * listing once it is sent too; the slug only until the post's send starts. Schedule, Send now,
 * and a reschedule take the same three fields, applied with the act.
 */
export interface ListingBody {
  email_only?: boolean;
  /** An archive address set by hand: lowercase letters, numbers, and single hyphens, and no
   *  other post's. Turns `slug_auto` off. */
  slug?: string;
  /** Have the slug follow the subject again (true), or keep it as it stands (false). */
  slug_auto?: boolean;
}

/** PUT /api/posts/:id/listing: the post as it now stands, and whether the act changed it. */
export interface ListingResponse {
  post: Post;
  slug_taken: SlugTaken;
  /** False when the post was already listed as asked: nothing was written. */
  changed: boolean;
}
