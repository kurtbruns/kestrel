/**
 * Freeze + soft-lock (I3, I6). Scheduling makes the email: it renders the post NOW —
 * its content, the template revision chosen for it, and the current identity — stores
 * the bytes on a `sends` row, and locks the post to draft-edits. Canceling is a CAS
 * that only succeeds while the send is still `scheduled` — the cancel window is
 * exactly the review window. The template update re-freezes a scheduled send in
 * place with the current template (SPEC §9); a move touches only the fire time.
 */

import { listImages } from "../db/images";
import type { PostRow } from "../db/posts";
import { getCurrentRevision, getPost, setPostStatusStmt } from "../db/posts";
import {
  type FrozenRender,
  getActiveSendForPost,
  getSend,
  insertScheduledSendStmt,
  latestSendForPost,
  refreezeSend,
  type SendRow,
} from "../db/sends";
import { getSettings } from "../db/settings";
import { audienceEmails } from "../db/subscribers";
import {
  getTemplateRevision,
  type TemplateRevisionRef,
  type TemplateRevisionRow,
  templateRevisionRef,
} from "../db/template_revisions";
import type { AppEnv, Config } from "../env";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { SEND_NOW_BUFFER_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { resolveBranding } from "../render/template_engine";
import { currentTemplateRevision } from "../services/template_history";

/**
 * The template facts about a post (SPEC §6, §9): the current revision, the revision
 * the post was last made with, and whether the two differ — the one condition under
 * which making the post again needs a choice. `last_made_with` is the post's most
 * recent send's revision; a send from before the history existed recorded none, so a
 * post whose only sends are unrecorded reads as never made (there is no "the one it
 * had" to name).
 */
export interface PostTemplateFacts {
  current: TemplateRevisionRef;
  last_made_with: TemplateRevisionRef | null;
  changed_since_last_made: boolean;
}

/** Read the template facts for a post, recording the current template if the history
 *  is empty (see `currentTemplateRevision`). */
export async function postTemplateFacts(
  db: D1Database,
  postId: string,
): Promise<{
  facts: PostTemplateFacts;
  current: TemplateRevisionRow;
  last: TemplateRevisionRow | null;
}> {
  const current = await currentTemplateRevision(db);
  const latest = await latestSendForPost(db, postId);
  const last = latest?.template_revision
    ? await getTemplateRevision(db, latest.template_revision)
    : null;
  const lastRef = last ? templateRevisionRef(last) : null;
  return {
    current,
    last,
    facts: {
      current: templateRevisionRef(current),
      last_made_with: lastRef,
      changed_since_last_made: lastRef !== null && lastRef.revision !== current.id,
    },
  };
}

/**
 * Pick the template revision a freeze uses (SPEC §6 "The soft-lock", §9). A post
 * never made before, or made with the template that is still current, takes the
 * current revision with no choice asked. When the template has changed since the
 * post was last made, the request must name the revision to use — the one it had or
 * the current one — and is refused until it does, so making a post again never
 * silently changes its look. The choice is an id, not "keep"/"current", so it stays
 * exact even if the template is saved between the read and this write.
 */
async function chooseTemplateRevision(
  db: D1Database,
  post: PostRow,
  requested: string | null | undefined,
): Promise<TemplateRevisionRow> {
  const { facts, current, last } = await postTemplateFacts(db, post.id);
  const refuse = (message: string) =>
    new HttpError(409, "template_choice_required", message, {
      template: { last_made_with: facts.last_made_with, current: facts.current },
    });
  if (requested == null) {
    if (facts.changed_since_last_made) {
      throw refuse(
        "the email template has changed since this post was last made; pass template_revision — the revision it was made with, or the current one",
      );
    }
    return current;
  }
  if (requested === current.id) {
    return current;
  }
  if (last && requested === last.id) {
    return last;
  }
  throw refuse(
    "template_revision must be the revision this post was last made with or the current one",
  );
}

/** The one render a freeze performs: the post's current content and images through
 *  the single render path (I5), inside `template` and the current identity. */
async function renderFrozen(
  env: AppEnv,
  config: Config,
  post: PostRow,
  template: TemplateRevisionRow,
): Promise<FrozenRender> {
  const revision = await getCurrentRevision(env.DB, post);
  if (!revision) {
    throw badRequest("post has no content to send");
  }
  const images = await listImages(env.DB, post.id);
  const settings = await getSettings(env.DB);
  const rendered = await render({ post, revision, images }, config, {
    ...resolveBranding(settings, config),
    template: template.html,
  });
  return {
    rendered_html: rendered.html,
    rendered_text: rendered.text,
    subject: rendered.subject,
    template_revision: template.id,
  };
}

/**
 * Create a scheduled Send from the post's current content and lock the post.
 * `templateRevision` is the request's choice (see `chooseTemplateRevision`); omit it
 * to take the current template where no choice is needed.
 */
export async function freeze(
  env: AppEnv,
  config: Config,
  post: PostRow,
  fireAt: number,
  templateRevision?: string | null,
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
  const template = await chooseTemplateRevision(env.DB, post, templateRevision);
  const rendered = await renderFrozen(env, config, post, template);
  const audience = await audienceEmails(env.DB);

  const now = Date.now();
  const id = newId();
  try {
    await env.DB.batch([
      insertScheduledSendStmt(
        env.DB,
        { ...rendered, id, post_id: post.id, fire_at: fireAt, recipient_count: audience.length },
        now,
      ),
      setPostStatusStmt(env.DB, post.id, "draft", "scheduled", now),
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
 * Update a scheduled send to the current template (SPEC §9): the SAME send, its render
 * frozen again from the same content with the current template and identity, at the
 * same fire time, still `scheduled` and cancelable. An update is a freeze, so it obeys
 * the freeze's guards: only a `scheduled` send (the CAS in `refreezeSend`), and never
 * inside the minimum lead — a send about to fire is refused rather than re-frozen under
 * the sweep, the same guard a move obeys (I6). The sign-off resets: the last approving
 * test should be of the copy that fires (SPEC §6).
 */
export async function updateTemplate(
  env: AppEnv,
  config: Config,
  sendId: string,
): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  if (send.status !== "scheduled") {
    throw conflict("send is not updatable (already sending, sent, or canceled)");
  }
  const minFireAt = Date.now() + SEND_NOW_BUFFER_MS;
  if (send.fire_at < minFireAt) {
    throw conflict(
      `send fires within the minimum lead (${SEND_NOW_BUFFER_MS / 60000} minutes); reschedule it further out to update its template`,
    );
  }
  const post = unwrap(await getPost(env.DB, send.post_id), "post");
  const template = await currentTemplateRevision(env.DB);
  const rendered = await renderFrozen(env, config, post, template);
  // Re-checked in the UPDATE itself: the send may have fired or been canceled since the
  // read above, and a CAS is the only guard that holds across that gap.
  const ok = await refreezeSend(env.DB, sendId, rendered, Date.now() + SEND_NOW_BUFFER_MS);
  if (!ok) {
    throw conflict("send is not updatable (already sending, sent, canceled, or about to fire)");
  }
  return unwrap(await getSend(env.DB, sendId), "send");
}

/**
 * Move a scheduled Send's fire time without re-freezing (I3) or resetting the review
 * window (I6). Distinct from the cancel → edit → schedule-again path (which is for
 * *content* changes) and from the template update (which re-freezes): this touches only
 * `fire_at`, so the frozen render is untouched (the audience is resolved when the send
 * fires, not here) and it stays the post's single active send throughout — only the
 * moment it fires changes. A CAS on `scheduled` status is the guarantee: a send that has
 * begun sending (or is sent or canceled) is past the window and cannot be moved, even if
 * it transitions between the read and the update. The reverse race — the sweep firing a
 * send this call just moved forward — is closed on the sweep side, where `acquireLease`
 * re-checks `fire_at` before leasing a `scheduled` send.
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
