/**
 * A post as the API answers it (docs/API.md, principle 2): one shape on every route, in a list,
 * alone, in an act's answer, and in a refusal. A stored post plus its two addresses and where it
 * stands for readers, who wrote its current revision, a reference to its send, and
 * `actions`, exactly what the server would take for it now, so neither client works out from
 * `status` whether a post can be edited, scheduled, sent, or deleted (principle 3).
 */

import type { Post, PostAction } from "../../shared/posts";
import { currentAuthors, getPost, type PostRow } from "../db/posts";
import { postSendRefs, publicationsFor } from "../db/sends";
import type { AppEnv, Config } from "../env";
import { withAddresses } from "../lib/archive_address";
import { HttpError } from "../lib/errors";
import { unwrap } from "../lib/unwrap";

/**
 * What can be done to a post now, as its routes would take it given its state and the
 * deployment: a draft's text is edited and deleted (a scheduled or sent post's is frozen, I3),
 * and a draft is scheduled or sent now while a provider is connected (SPEC §6, §9). A blank
 * subject doesn't withdraw them: it is the one thing the publisher fixes in the act itself, so
 * it stays a refusal naming the field (`subject_required`), as a fire time inside the lead does.
 * A change to the post's settings is taken in any state, so it is no action of its own.
 */
export function postActions(
  post: Pick<PostRow, "id" | "status">,
  config: Pick<Config, "provider">,
): PostAction[] {
  if (post.status !== "draft") {
    return [];
  }
  const path = `/api/posts/${post.id}`;
  const actions: PostAction[] = [
    { name: "edit", method: "PUT", path },
    { name: "delete", method: "DELETE", path },
  ];
  if (config.provider !== "none") {
    actions.push(
      { name: "schedule", method: "POST", path: `${path}/schedule` },
      { name: "send_now", method: "POST", path: `${path}/send` },
    );
  }
  return actions;
}

/** Stored posts as the API answers them, in the order given: a few reads for all of them. */
export async function viewPosts(env: AppEnv, config: Config, rows: PostRow[]): Promise<Post[]> {
  const ids = rows.map((r) => r.id);
  const [published, authors, sends] = await Promise.all([
    publicationsFor(env.DB, ids),
    currentAuthors(env.DB, rows),
    postSendRefs(env.DB, ids),
  ]);
  return rows.map((row) => ({
    ...withAddresses(config, row, published.get(row.id) ?? null),
    author: authors.get(row.id)?.author ?? null,
    author_client: authors.get(row.id)?.client ?? null,
    send: sends.get(row.id) ?? null,
    actions: postActions(row, config),
  }));
}

/** One stored post as the API answers it. */
export async function viewPost(env: AppEnv, config: Config, row: PostRow): Promise<Post> {
  const [post] = await viewPosts(env, config, [row]);
  return unwrap(post, "post view");
}

/**
 * Run an act on a post. A refusal about the post's state, that it is no longer a draft
 * (`post_not_draft`) or that its address is fixed (`slug_permanent`), carries the post as it
 * now stands (docs/API.md, principle 5), read after the refusal, so a client redraws it
 * without a second read.
 */
export async function carryingPost<T>(
  env: AppEnv,
  config: Config,
  postId: string,
  act: () => Promise<T>,
): Promise<T> {
  try {
    return await act();
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.code === "post_not_draft" || err.code === "slug_permanent") &&
      err.details?.post === undefined
    ) {
      const row = await getPost(env.DB, postId);
      if (row) {
        throw new HttpError(err.code, err.message, {
          ...err.details,
          post: await viewPost(env, config, row),
        });
      }
    }
    throw err;
  }
}
