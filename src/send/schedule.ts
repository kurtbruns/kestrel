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
import { getSettings } from "../db/settings";
import { audienceEmails } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { resolveBranding } from "../render/template_engine";

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
  // The subject is the one field the reader sees in their inbox (SPEC §6). One
  // check here covers both Schedule and Send-now and both clients (editor + API);
  // whitespace-only counts as empty.
  if (!post.subject.trim()) {
    throw badRequest("add a subject before sending");
  }
  if (await getActiveSendForPost(env.DB, post.id)) {
    throw conflict("post already has an active send");
  }
  const revision = await getCurrentRevision(env.DB, post);
  if (!revision) {
    throw badRequest("post has no content to send");
  }

  const images = await listImages(env.DB, post.id);
  const settings = await getSettings(env.DB);
  const rendered = await render(
    { post, revision, images },
    config,
    resolveBranding(settings, config),
  );
  const audience = await audienceEmails(env.DB);

  const now = Date.now();
  const id = newId();
  try {
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
  } catch (err) {
    // The pre-check above is UX, not the guarantee: a concurrent freeze() for the
    // same post can pass it and reach here. The partial unique index (`idx_sends_one_active_per_post`)
    // is the real backstop — it fails the loser's insert, which we map to the same
    // friendly conflict so the DB, not check-then-act, enforces one active send (I4, I6).
    if (isActiveSendConflict(err)) {
      throw conflict("post already has an active send");
    }
    throw err;
  }
  return unwrap(await getSend(env.DB, id), "send");
}

/** True for the D1/SQLite violation of the "one active send per post" partial unique index. */
function isActiveSendConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*sends\.post_id/i.test(message);
}

/**
 * Move a scheduled Send's fire time without re-freezing (I3) or resetting the review
 * window (I6). Distinct from the unschedule → edit → re-schedule path (which is for
 * *content* changes): this touches only `fire_at`, so the frozen render is untouched (the
 * audience is resolved when the send fires, not here) and it stays the post's single
 * active send throughout — only the moment it fires changes. A CAS on `scheduled` status
 * is the guarantee: a send that has begun sending (or is sent or canceled) is past the
 * window and cannot be moved,
 * even if it transitions between the read and the update. The reverse race — the sweep
 * firing a send this call just moved forward — is closed on the sweep side, where
 * `acquireLease` re-checks `fire_at` before leasing a `scheduled` send.
 */
export async function reschedule(env: AppEnv, sendId: string, fireAt: number): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const res = await env.DB.prepare(
    "UPDATE sends SET fire_at = ? WHERE id = ? AND status = 'scheduled'",
  )
    .bind(fireAt, sendId)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict("send is not reschedulable (already sending, sent, or canceled)");
  }
  return unwrap(await getSend(env.DB, sendId), "send");
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
