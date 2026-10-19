// Posts as the API carries them (SPEC §4): the one shape every route answers, its send and
// what can be done to it included, and the bodies of the post routes. The Worker's routes produce these shapes
// and the editor consumes them; one definition, so neither can drift.

import type { PageMeta } from "./list";
import type { SendView } from "./sends";

/** A post's statuses, in their order, which the list's `status` filter takes. */
export const POST_STATUSES = ["draft", "scheduled", "sent"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * A post's reference to its send: one fixed shape on every route that carries a post. `rev` is
 * the send's own (`SendView.rev`), so a client that also holds the send's view, from the feed,
 * tells whether that copy is current.
 */
export type SendRef = Pick<SendView, "id" | "status" | "fire_at" | "rev">;

/** Something a person can do to a post through the API, exactly as the server would take it now. */
export interface PostAction {
  name: "edit" | "delete" | "schedule" | "send_now";
  method: "PUT" | "DELETE" | "POST";
  /** The route, with the post's id filled in. */
  path: string;
}

export interface Post {
  id: string;
  /**
   * The last part of the post's archive address, `archive_url` (SPEC §4): unique among all
   * posts, drafts included, and fixed once the post's send starts.
   */
  slug: string;
  /**
   * Whether the slug follows the subject: derived from it again on every draft save, unless
   * another post holds that slug (`subject_slug_held`). False once a slug is set by hand.
   */
  slug_auto: boolean;
  /**
   * The post's unlisted link is `<app origin>/email/<unlisted_token>` (SPEC §5): made with the
   * post, never changed, and carried as "view in browser" by every test and send.
   */
  unlisted_token: string;
  /**
   * The post's archive address, absolute, whether or not it answers yet (SPEC §4, §5): where a
   * listed post is published once its send starts. A send's `links.archive` is the same address
   * only while it answers.
   */
  archive_url: string;
  /** The post's unlisted link, absolute: the "view in browser" every email of it carries (SPEC §5). */
  unlisted_url: string;
  /**
   * When the post's send started, which is when it was published (SPEC §5); null before. Its
   * unlisted link shows the post exactly when this is set. `status` can't say it: a post stays
   * `scheduled` while its send is going out.
   */
  published_at: number | null;
  /**
   * Whether `archive_url` shows the post now (SPEC §5): once published, while it is listed, or
   * whatever the listing for a post whose emails carry that address (sent before unlisted
   * links). Where a reader can see it: `archive_url` when this is true, otherwise
   * `unlisted_url` once `published_at` is set.
   */
  archive_live: boolean;
  subject: string;
  status: PostStatus;
  /**
   * The post's listing (SPEC §5): true when it is email only, mailed as usual but left out of
   * the archive index and the home page, its archive address answering nothing; false,
   * the default, when it is listed in the archive. Not part of the frozen render, so it can
   * change in any state, a sent post's included (`PUT /api/posts/:id/settings`).
   */
  email_only: boolean;
  /** The current revision's id; the editor carries it on every save (optimistic concurrency). */
  current_revision: string | null;
  /** Who wrote the current revision: a person's email, or `service` for a service token
   *  (SPEC §4, §11). */
  author: string | null;
  /** The client the current revision's author came through, as it named itself (`editor`,
   *  `claude-code`); null when it named none, and on a service token's (SPEC §11). */
  author_client: string | null;
  created_at: number;
  updated_at: number;
  /**
   * The post's send, by reference (SPEC §6, §8): its active send, the one scheduled or going
   * out, else the one that sent it; null for a post with neither. A post stays `scheduled`
   * while its send goes out, so the reference's `status` says which it is. The send's whole
   * view is `GET /api/sends/:id`, and the feed's.
   */
  send: SendRef | null;
  /** Exactly what the server would take for this post now, each with its method and path. */
  actions: PostAction[];
}

/** GET /api/posts */
export interface PostListResponse {
  posts: Post[];
  page: PageMeta;
  /**
   * Where this read stood among the changes to sends (`<seq>.<at>`, as on `GET /api/sends`), to
   * follow the listed posts' sends from with `GET /api/sends/feed`.
   */
  cursor: string;
}

/**
 * `subject_slug_held` on a post's answers: when the post's slug follows its subject but another
 * post holds the subject's slug, that slug. The post took the first free number after it, and a
 * client says why. Not a refusal (that is the 409 `slug_taken` error). Null otherwise, and once
 * the post is published, since its address is fixed (SPEC §4).
 */
export type SubjectSlugHeld = string | null;

/** GET /api/posts/:id: the post, with where its send stands, and its current text. */
export interface PostResponse {
  post: Post;
  subject_slug_held: SubjectSlugHeld;
  markdown: string;
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
  subject_slug_held: SubjectSlugHeld;
  revision_id: string;
}

/** GET /api/posts/:id/preview.json: where the rendered page is, and whether it is a frozen send's copy. */
export interface PreviewResponse {
  url: string;
  subject: string;
  warnings: string[];
  frozen: boolean;
}

/**
 * Why a test didn't go to an address, as the provider answered (SPEC §5): its own words,
 * and the server's sentence saying what that means and what to do, to show or relay as it
 * stands.
 */
export interface TestNotSent {
  /** True when the provider never answered, so the test may have arrived all the same. */
  may_have_arrived: boolean;
  /** The provider's own words. Never carries a credential. */
  error: string;
  /** The sentence to show: what happened, then the fix where it is known. */
  message: string;
}

/** POST /api/posts/:id/test: one test delivery through the same render as a real send (I5). */
export interface TestSendResponse {
  /** True only when the provider took the test. */
  sent: boolean;
  /** Why it wasn't sent; null when it was. */
  not_sent: TestNotSent | null;
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

/** One saved version of a post: who saved it, when, and the subject and slug it was saved with. */
export interface PostRevision {
  /** Its number, from 1, oldest first: the `:n` that reads it. */
  n: number;
  /** What a save names as `base_revision`. */
  id: string;
  /** A person's email, or `service` for a service token. */
  author: string | null;
  /** The client the author came through, as it named itself; null when it named none, and on
   *  a service token's (SPEC §11). */
  author_client: string | null;
  created_at: number;
  metadata: { subject: string; slug: string };
}

/** GET /api/posts/:id/revisions: the history, oldest first, without the bodies. */
export interface RevisionListResponse {
  revisions: (PostRevision & { is_current: boolean })[];
}

/** GET /api/posts/:id/revisions/:n: one revision, with its body. */
export interface RevisionResponse extends PostRevision {
  markdown: string;
}

/**
 * The 409 a save gets when its base revision is no longer the newest: the post as it stands and
 * its current text, so the client can re-apply its change without reading it again.
 */
export interface StaleRevisionError {
  error: "stale_revision";
  message: string;
  current_revision: string | null;
  updated_at: number;
  author: string | null;
  author_client: string | null;
  post: Post;
  markdown: string;
}

/**
 * What PUT /api/posts/:id/settings takes: the post's settings (SPEC §4, §5), any subset of them.
 * None is part of the frozen email, so they can change while the post is scheduled, and the
 * listing once it is sent too; the slug only until the post's send starts. Schedule and Send now
 * take the same three fields, applied with the act; a reschedule takes none.
 */
export interface PostSettingsBody {
  email_only?: boolean;
  /** An archive address set by hand: lowercase letters, numbers, and single hyphens, and no
   *  other post's. Turns `slug_auto` off. */
  slug?: string;
  /** Have the slug follow the subject again (true), or keep it as it stands (false). */
  slug_auto?: boolean;
}

/** PUT /api/posts/:id/settings: the post as it now stands, and whether the act changed it. */
export interface PostSettingsResponse {
  post: Post;
  subject_slug_held: SubjectSlugHeld;
  /** False when the post already had every setting asked for: nothing was written. */
  changed: boolean;
}
