// Posts as the API carries them (SPEC §4): the row both clients read, the list row with its
// active send, and the bodies of the post routes. The Worker's routes produce these shapes
// and the editor consumes them; one definition, so neither can drift.

import type { PageMeta } from "./list";

export type PostStatus = "draft" | "scheduled" | "sent";

export interface Post {
  id: string;
  slug: string;
  subject: string;
  status: PostStatus;
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

/** GET /posts */
export interface PostListResponse {
  posts: PostListItem[];
  page: PageMeta;
  /**
   * Where this read stood among the changes to sends (`<seq>.<at>`, as on `GET /sends`), to
   * follow the listed posts' sends from with `GET /sends/feed`.
   */
  cursor: string;
}

/** GET /posts/:id: the post, its current text, and where its send stands. */
export interface PostResponse {
  post: Post;
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
 * What POST /posts and PUT /posts/:id accept: any subset of the fields, and the revision
 * the editor loaded, which the server checks before it writes (optimistic concurrency).
 */
export interface PostEditBody {
  subject?: string;
  slug?: string;
  markdown?: string;
  base_revision?: string | null;
}

/** POST /posts and PUT /posts/:id: the post as saved, and the revision the save wrote. */
export interface PostSavedResponse {
  post: Post;
  revision_id: string;
}

/** GET /posts/:id/preview: where the rendered page is, and whether it is a frozen send's copy. */
export interface PreviewResponse {
  url: string;
  subject: string;
  warnings: string[];
  frozen: boolean;
}

/** POST /posts/:id/test: one test delivery through the same render as a real send (I5). */
export interface TestSendResponse {
  sent: boolean;
  provider: string;
  to: string;
  subject: string;
  warnings: string[];
  frozen: boolean;
}

/** The 409 a save gets when its base revision is no longer the newest. */
export interface StaleRevisionError {
  error: "stale_revision";
  message: string;
  current_revision: string | null;
  updated_at: number;
  author: string | null;
}
