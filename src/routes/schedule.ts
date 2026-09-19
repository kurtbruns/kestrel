/** Post send actions: schedule for a future time, or send now (buffered). Authed. */

import { getPost } from "../db/posts";
import { getActiveSendForPost } from "../db/sends";
import { badRequest, json, notFound } from "../lib/errors";
import { SEND_NOW_BUFFER_MS } from "../lib/time";
import type { RequestContext } from "../router";
import { param } from "../router";
import { freeze } from "../send/schedule";

/** Parse a `fire_at` field (ISO-8601 timestamp or epoch millis) to epoch millis, or throw a 400. */
function parseFireAt(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const iso = Date.parse(input);
    if (!Number.isNaN(iso)) {
      return iso;
    }
    const n = Number(input);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  throw badRequest("fire_at must be an ISO-8601 timestamp or epoch milliseconds");
}

/**
 * Parse `fire_at` and require it to be at least the review buffer out — the single
 * minimum-lead rule every future-dated send obeys, so scheduling and rescheduling can't
 * drift on it (I6). `immediateHint` appends the send-now pointer, which fits the schedule
 * path (a reschedule has no immediate alternative to point at).
 */
export function parseFutureFireAt(input: unknown, immediateHint = false): number {
  const fireAt = parseFireAt(input);
  if (fireAt < Date.now() + SEND_NOW_BUFFER_MS) {
    const hint = immediateHint ? "; use POST /posts/:id/send for immediate delivery" : "";
    throw badRequest(
      `fire_at must be at least ${SEND_NOW_BUFFER_MS / 60000} minutes in the future${hint}`,
    );
  }
  return fireAt;
}

/** The optional `template_revision` a schedule or send-now names (SPEC §6): a revision
 *  id, or absent. The freeze decides whether one was needed; this only checks the shape. */
function parseTemplateRevision(body: { template_revision?: unknown }): string | null {
  const v = body.template_revision;
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "string" || !v.trim()) {
    throw badRequest("template_revision must be a template revision id");
  }
  return v;
}

export async function schedule(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }

  let body: { fire_at?: unknown; template_revision?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw badRequest("JSON body with 'fire_at' is required");
  }
  const fireAt = parseFutureFireAt(body.fire_at, true);
  const send = await freeze(c.env, c.config, post, fireAt, parseTemplateRevision(body));
  return json({ send }, 201);
}

export async function sendNow(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }

  // Idempotent: if a send is already in flight for this post, return it.
  const active = await getActiveSendForPost(c.env.DB, post.id);
  if (active) {
    return json({ send: active, idempotent: true });
  }

  // The body is optional (send-now has no required field); it may carry the template
  // choice when the post was made before and the template has changed since.
  let body: { template_revision?: unknown } = {};
  try {
    body = ((await c.req.json()) ?? {}) as typeof body;
  } catch {
    /* no body — no choice named */
  }
  const send = await freeze(
    c.env,
    c.config,
    post,
    Date.now() + SEND_NOW_BUFFER_MS,
    parseTemplateRevision(body),
  );
  return json({ send }, 201);
}
