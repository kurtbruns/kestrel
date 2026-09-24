/**
 * Freeze + soft-lock (I3, I6). Scheduling makes the email: it renders the post NOW,
 * with the template and the identity as they stand, stores the bytes on a `sends`
 * row, and locks the post to draft-edits. Canceling is a CAS that only succeeds while
 * the send is still `scheduled` — the cancel window is exactly the review window. A
 * later template or identity change re-makes the frozen render in place (remake.ts);
 * a move touches only the fire time.
 */

import { listImages } from "../db/images";
import type { PostRow } from "../db/posts";
import { getCurrentRevision, setPostStatusStmt } from "../db/posts";
import {
  cancelStmt,
  type FrozenRender,
  getActiveSendForPost,
  getSend,
  insertScheduledSendStmt,
  noActiveSendFor,
  rescheduleStmt,
  type SendRow,
  settingsVersionIs,
} from "../db/sends";
import { readSettings } from "../db/settings";
import { audienceCount } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { log } from "../lib/log";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { type EmailBranding, resolveBranding } from "../render/template_engine";

/** The one render a freeze performs: the post's current content and images through
 *  the single render path (I5), inside `branding` (the template plus the identity).
 *  Shared by the schedule and the re-make, so the two cannot drift on what they render. */
export async function renderPost(
  env: AppEnv,
  config: Config,
  post: PostRow,
  branding: EmailBranding,
): Promise<FrozenRender> {
  const revision = await getCurrentRevision(env.DB, post);
  if (!revision) {
    throw badRequest("post has no content to send");
  }
  const images = await listImages(env.DB, post.id);
  const rendered = await render({ post, revision, images }, config, branding);
  return { rendered_html: rendered.html, rendered_text: rendered.text, subject: rendered.subject };
}

/** How many times a freeze re-reads and re-renders when the settings changed under it.
 *  A template save landing in that gap is rare; a couple of retries settles it. */
const FREEZE_RETRIES = 3;

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

  for (let attempt = 0; attempt < FREEZE_RETRIES; attempt++) {
    // Render with the settings as they stand, and remember which: the insert below
    // lands only while the settings row is still at this version. A template or
    // identity save that commits in between (a re-make of every scheduled send, SPEC
    // §9) would otherwise leave this new send on the older look, unlisted; instead
    // the insert changes zero rows and the freeze renders again with the new settings.
    const { settings, version } = await readSettings(env.DB);
    const rendered = await renderPost(env, config, post, resolveBranding(settings, config));
    const audience = await audienceCount(env.DB);

    const now = Date.now();
    const id = newId();
    const settingsVersion = version ?? 0;
    let results: D1Result[];
    try {
      results = await env.DB.batch([
        insertScheduledSendStmt(
          env.DB,
          { ...rendered, id, post_id: post.id, fire_at: fireAt, recipient_count: audience },
          now,
          settingsVersion,
        ),
        setPostStatusStmt(
          env.DB,
          post.id,
          "draft",
          "scheduled",
          now,
          settingsVersionIs(settingsVersion),
        ),
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
    if ((results[0]?.meta.changes ?? 0) > 0) {
      return unwrap(await getSend(env.DB, id), "send");
    }
  }
  throw conflict("the template or identity changed while scheduling; try again");
}

/** True for the D1/SQLite violation of the "one active send per post" partial unique index. */
function isActiveSendConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*sends\.post_id/i.test(message);
}

/**
 * Move a scheduled Send's fire time without re-freezing (I3) or resetting the review
 * window (I6). Distinct from the cancel → edit → schedule-again path (which is for
 * *content* changes): this touches only `fire_at`, so the frozen render is untouched (the
 * audience is resolved when the send fires, not here) and it stays the post's single
 * active send throughout — only the moment it fires changes. A CAS on `scheduled` status
 * is the guarantee: a send that has begun sending (or is sent or canceled) is past the
 * window and cannot be moved, even if it transitions between the read and the update.
 * The reverse race — the sweep firing a send this call just moved forward — is closed
 * on the sweep side, where `acquireLease` re-checks `fire_at` before leasing a
 * `scheduled` send.
 */
export async function reschedule(env: AppEnv, sendId: string, fireAt: number): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const res = await rescheduleStmt(env.DB, sendId, fireAt).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict("send is not reschedulable (already sending, sent, or canceled)");
  }
  log.info("send.rescheduled", {
    sendId,
    postId: send.post_id,
    fireAt: new Date(fireAt).toISOString(),
    movedMs: fireAt - send.fire_at,
  });
  return unwrap(await getSend(env.DB, sendId), "send");
}

/** Cancel a pending Send and unlock its post, in one batch so the two land together:
 *  a post left `scheduled` with no active send would be locked out of the editor.
 *  Only works while `scheduled`. */
export async function cancel(env: AppEnv, sendId: string): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  const now = Date.now();
  const [res] = await env.DB.batch([
    cancelStmt(env.DB, sendId, now),
    setPostStatusStmt(
      env.DB,
      send.post_id,
      "scheduled",
      "draft",
      now,
      noActiveSendFor(send.post_id),
    ),
  ]);
  if ((res?.meta.changes ?? 0) === 0) {
    throw conflict("send is not cancelable (already sending, sent, or canceled)");
  }
  log.info("send.canceled", { sendId, postId: send.post_id });
  return unwrap(await getSend(env.DB, sendId), "send");
}
