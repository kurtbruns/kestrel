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

export async function schedule(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }

  let body: { fire_at?: unknown };
  try {
    body = (await c.req.json()) as { fire_at?: unknown };
  } catch {
    throw badRequest("JSON body with 'fire_at' is required");
  }
  const fireAt = parseFutureFireAt(body.fire_at, true);
  const send = await freeze(c.env, c.config, post, fireAt);
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

  const send = await freeze(c.env, c.config, post, Date.now() + SEND_NOW_BUFFER_MS);
  return json({ send }, 201);
}
