/**
 * Freeze + soft-lock (I3, I6). Scheduling makes the email: it renders the post NOW,
 * with the template and the identity as they stand, stores the bytes on a `sends`
 * row, and locks the post to draft-edits. Canceling and moving are a CAS that only
 * succeeds inside the review window, which closes at the fire time (SPEC §6), whether or
 * not the sweep has started the send. A later template or identity change re-makes the
 * frozen render in place (remake.ts); a move touches only the fire time.
 *
 * Each refusal has a code of its own and carries the send as it stands where there is one
 * (`window_closed`, `send_canceled`, `post_not_draft`, `active_send_exists`, and the rest).
 * An action that finds the send already as asked (canceled already, or already at that
 * time) answers `changed: false` rather than refusing, so a retried request is safe; one
 * that names the `rev` it last read (`If-Match`) is refused with `precondition_failed` if
 * the send has changed since.
 */

import { formatLead } from "../../shared/sends";
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
import { badRequest, notFound, refusal } from "../lib/errors";
import { newId } from "../lib/ids";
import { log } from "../lib/log";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { type EmailBranding, resolveBranding } from "../render/template_engine";
import { describeSend } from "./describe";

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
  const active = await getActiveSendForPost(env.DB, post.id);
  if (active) {
    throw await activeSendExists(env, active);
  }
  if (post.status !== "draft") {
    throw refusal(409, "post_not_draft", `post is ${post.status}, not a draft`);
  }
  // The subject is the one field the reader sees in their inbox (SPEC §6). One
  // check here covers both Schedule and Send-now and both clients (editor + API);
  // whitespace-only counts as empty.
  if (!post.subject.trim()) {
    throw refusal(400, "subject_required", "add a subject before sending", { field: "subject" });
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
        const winner = await getActiveSendForPost(env.DB, post.id);
        throw winner
          ? await activeSendExists(env, winner)
          : refusal(409, "active_send_exists", "post already has an active send");
      }
      throw err;
    }
    if ((results[0]?.meta.changes ?? 0) > 0) {
      return unwrap(await getSend(env.DB, id), "send");
    }
  }
  throw refusal(
    409,
    "settings_changed",
    "the template or identity changed while scheduling; try again",
  );
}

/** The refusal for a post that already has its one active send, carrying that send. */
async function activeSendExists(env: AppEnv, send: SendRow) {
  return refusal(409, "active_send_exists", "post already has an active send", {
    send: await describeSend(env.DB, send),
  });
}

/** True for the D1/SQLite violation of the "one active send per post" partial unique index. */
function isActiveSendConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*sends\.post_id/i.test(message);
}

/** What an action on a send may carry: the `rev` the caller last read (`If-Match`). */
export interface ActionGuard {
  ifMatch?: number;
}

/** An action's answer: the send as it now stands, and whether the action wrote anything. */
export interface ActionResult {
  send: SendRow;
  changed: boolean;
}

/** Read the send, 404 if it is gone, and refuse with `precondition_failed` if the caller
 *  named a `rev` it no longer holds. */
async function readForAction(env: AppEnv, sendId: string, guard: ActionGuard): Promise<SendRow> {
  const send = await getSend(env.DB, sendId);
  if (!send) {
    throw notFound("send");
  }
  if (guard.ifMatch !== undefined && send.rev !== guard.ifMatch) {
    throw refusal(
      412,
      "precondition_failed",
      `the send has changed since rev ${guard.ifMatch} (it is at rev ${send.rev}); read it again and decide on what it is now`,
      { send: await describeSend(env.DB, send) },
    );
  }
  return send;
}

/** The refusal for an action on a send past its review window: due, sending, or sent. */
async function windowClosed(env: AppEnv, send: SendRow, what: string) {
  const why =
    send.status === "scheduled"
      ? "its fire time has passed and it is about to send"
      : `it is ${send.status}`;
  return refusal(409, "window_closed", `send can no longer be ${what}: ${why}`, {
    send: await describeSend(env.DB, send),
  });
}

/**
 * Move a scheduled Send's fire time without re-freezing (I3) or resetting the review
 * window (I6). Distinct from the cancel → edit → schedule-again path (which is for
 * *content* changes): this touches only `fire_at`, so the frozen render is untouched (the
 * audience is resolved when the send fires, not here) and it stays the post's single
 * active send throughout — only the moment it fires changes. A CAS on the review window
 * is the guarantee: a send whose fire time has passed (or is sending, sent, or canceled)
 * cannot be moved, even if it changes between the read and the update. The reverse race
 * — the sweep firing a send this call just moved forward — is closed on the sweep side,
 * where `acquireLease` re-checks `fire_at` before leasing a `scheduled` send.
 *
 * A move to the time the send already has changes nothing and answers `changed: false`
 * before the minimum lead is checked, so a retried move is safe; any other time must be at
 * least `minLeadMs` out (`fire_at_too_soon`).
 */
export async function reschedule(
  env: AppEnv,
  sendId: string,
  fireAt: number,
  minLeadMs: number,
  guard: ActionGuard = {},
): Promise<ActionResult> {
  const send = await readForAction(env, sendId, guard);
  const now = Date.now();
  if (send.status === "canceled") {
    throw refusal(409, "send_canceled", "send is canceled; schedule the post again instead", {
      send: await describeSend(env.DB, send),
    });
  }
  if (send.status !== "scheduled" || send.fire_at <= now) {
    throw await windowClosed(env, send, "rescheduled");
  }
  if (send.fire_at === fireAt) {
    return { send, changed: false };
  }
  if (fireAt < now + minLeadMs) {
    throw refusal(
      400,
      "fire_at_too_soon",
      `fire_at must be at least ${formatLead(minLeadMs)} in the future, this deployment's minimum lead`,
      { field: "fire_at" },
    );
  }
  const res = await rescheduleStmt(env.DB, sendId, fireAt, now, guard.ifMatch ?? null).run();
  if ((res.meta.changes ?? 0) === 0) {
    // It changed between the read and the write: answer for what it is now.
    return reschedule(env, sendId, fireAt, minLeadMs, guard);
  }
  log.info("send.rescheduled", {
    sendId,
    postId: send.post_id,
    fireAt: new Date(fireAt).toISOString(),
    movedMs: fireAt - send.fire_at,
  });
  return { send: unwrap(await getSend(env.DB, sendId), "send"), changed: true };
}

/** Cancel a pending Send and unlock its post, in one batch so the two land together:
 *  a post left `scheduled` with no active send would be locked out of the editor.
 *  Only inside the review window; a send canceled already answers `changed: false`. */
export async function cancel(
  env: AppEnv,
  sendId: string,
  guard: ActionGuard = {},
): Promise<ActionResult> {
  const send = await readForAction(env, sendId, guard);
  if (send.status === "canceled") {
    return { send, changed: false };
  }
  const now = Date.now();
  if (send.status !== "scheduled" || send.fire_at <= now) {
    throw await windowClosed(env, send, "canceled");
  }
  const [res] = await env.DB.batch([
    cancelStmt(env.DB, sendId, now, guard.ifMatch ?? null),
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
    // It changed between the read and the write: answer for what it is now.
    return cancel(env, sendId, guard);
  }
  log.info("send.canceled", { sendId, postId: send.post_id });
  return { send: unwrap(await getSend(env.DB, sendId), "send"), changed: true };
}
