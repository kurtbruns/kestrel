/**
 * Freeze + soft-lock (I3, I6). Scheduling renders the post NOW and stores the
 * bytes on a `sends` row, then locks the post to draft-edits. Canceling
 * (= unscheduling) is a CAS that only succeeds while the send is still
 * `scheduled` — the cancel window is exactly the review window.
 */

import { listImages } from "../db/images";
import type { PostRow } from "../db/posts";
import { getCurrentRevision } from "../db/posts";
import { getActiveSendForPost, getSend, type SendRow } from "../db/sends";
import { audienceEmails } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";

/** Create a scheduled Send from the post's current content and lock the post. */
export async function freeze(
  env: AppEnv,
  config: Config,
  post: PostRow,
  fireAt: number,
): Promise<SendRow> {
  if (post.status !== "draft") {
    throw conflict("post is not a draft");
  }
  if (await getActiveSendForPost(env.DB, post.id)) {
    throw conflict("post already has an active send");
  }
  const revision = await getCurrentRevision(env.DB, post);
  if (!revision) {
    throw badRequest("post has no content to send");
  }

  const images = await listImages(env.DB, post.id);
  const rendered = render({ post, revision, images }, config);
  const audience = await audienceEmails(env.DB);

  const now = Date.now();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, scheduled_at) VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      post.id,
      fireAt,
      rendered.html,
      rendered.text,
      rendered.subject,
      audience.length,
      now,
    ),
    env.DB.prepare(
      "UPDATE posts SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'draft'",
    ).bind(now, post.id),
  ]);
  return unwrap(await getSend(env.DB, id), "send");
}

/** Cancel a pending Send and unlock its post. Only works while `scheduled`. */
export async function cancel(env: AppEnv, sendId: string): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const now = Date.now();
  const res = await env.DB.prepare(
    "UPDATE sends SET status = 'canceled', completed_at = ? WHERE id = ? AND status = 'scheduled'",
  )
    .bind(now, sendId)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict("send is not cancelable (already sending, sent, or canceled)");
  }
  await env.DB.prepare(
    "UPDATE posts SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'scheduled'",
  )
    .bind(now, send.post_id)
    .run();
  return unwrap(await getSend(env.DB, sendId), "send");
}
