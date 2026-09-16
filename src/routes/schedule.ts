/** Post send actions: schedule for a future time, or send now (buffered). Authed. */

import { getPost } from "../db/posts";
import { getActiveSendForPost } from "../db/sends";
import { badRequest, json, notFound } from "../lib/errors";
import { SEND_NOW_BUFFER_MS } from "../lib/time";
import type { RequestContext } from "../router";
import { param } from "../router";
import { freeze } from "../send/schedule";

/** Parse a `fire_at` field (ISO-8601 timestamp or epoch millis) to epoch millis, or
 *  throw a 400. Shared by scheduling and rescheduling so both accept the same shapes. */
export function parseFireAt(input: unknown): number {
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
  const fireAt = parseFireAt(body.fire_at);
  const earliest = Date.now() + SEND_NOW_BUFFER_MS;
  if (fireAt < earliest) {
    throw badRequest(
      `fire_at must be at least ${SEND_NOW_BUFFER_MS / 60000} minutes in the future; use POST /posts/:id/send for immediate delivery`,
    );
  }

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
