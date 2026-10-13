/** Post send actions: schedule for a future time, or send now (buffered). Authed. */

import type { ScheduleResponse } from "../../shared/sends";
import { getPost } from "../db/posts";
import { getActiveSendForPost, type SendRow } from "../db/sends";
import { fieldError, readJsonObject } from "../lib/body";
import { HttpError, json, notFound } from "../lib/errors";
import { unwrap } from "../lib/unwrap";
import { requireConnectedProvider } from "../providers";
import type { RequestContext } from "../router";
import { param } from "../router";
import { viewWithCursor } from "../send/describe";
import { acceptFireAt, freeze } from "../send/schedule";

/** An ISO-8601 timestamp that names its instant: a time part ending in `Z` or `±hh:mm`. */
const ISO_WITH_OFFSET = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Parse a `fire_at` field (epoch millis, or an ISO-8601 timestamp with an offset) to
 * epoch millis, or throw a 400. A timestamp without an offset is refused rather than
 * read as UTC: an API caller meaning the publisher's local 9am would fire hours off.
 */
export function parseFireAt(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const n = Number(input);
    if (input.trim() !== "" && Number.isFinite(n)) {
      return n;
    }
    const iso = Date.parse(input);
    if (!Number.isNaN(iso)) {
      if (!ISO_WITH_OFFSET.test(input.trim())) {
        throw fieldError(
          "fire_at",
          "fire_at must name its timezone: an ISO-8601 timestamp ending in Z or an offset like +02:00, or epoch milliseconds",
        );
      }
      return iso;
    }
  }
  throw fieldError(
    "fire_at",
    "fire_at must be an ISO-8601 timestamp with a Z or ±hh:mm offset, or epoch milliseconds",
  );
}

/**
 * Parse `fire_at` and pass it through `acceptFireAt`, the one gate every requested fire time
 * obeys (at least the minimum lead out, stored on the minute), so scheduling and rescheduling
 * can't drift on it (I6).
 */
export function parseFutureFireAt(input: unknown, minLeadMs: number): number {
  return acceptFireAt(parseFireAt(input), minLeadMs);
}

/**
 * A freeze always uses the template and identity as they stand (SPEC §6): there is no
 * per-send template to choose, so a request that tries to name one is refused rather
 * than silently given the current template. Keeps a client written against a design
 * that had such a field from believing its choice took.
 */
function rejectStrayTemplateChoice(body: unknown): void {
  if (body && typeof body === "object" && "template_revision" in body) {
    throw fieldError(
      "template_revision",
      "template_revision is not a field: a send is made with the template and identity as they stand, and a later change re-makes it",
    );
  }
}

export async function schedule(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }

  const body = await readJsonObject(c);
  rejectStrayTemplateChoice(body);
  requireConnectedProvider(c.config);
  const fireAt = parseFutureFireAt(body.fire_at, c.config.minLeadMs);
  const send = await freeze(c.env, c.config, post, fireAt);
  const frozen: ScheduleResponse = unwrap(await viewWithCursor(c.env, send.id), "send");
  return json(frozen, 201);
}

export async function sendNow(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  // Send-now needs no body, so an empty one needs no content type; one that is sent is
  // read like any other JSON body, only to refuse a stray template choice.
  rejectStrayTemplateChoice(await readJsonObject(c, { optional: true }));

  // Idempotent: if a send is already in flight for this post, return it.
  const active = await getActiveSendForPost(c.env.DB, post.id);
  if (active) {
    return repeatAnswer(c, active.id);
  }

  requireConnectedProvider(c.config);
  // The soonest time the lead allows, through the same gate as a schedule, so it lands on
  // the minute at or after it like any other fire time.
  const now = Date.now();
  const fireAt = acceptFireAt(now + c.config.minLeadMs, c.config.minLeadMs, { now });
  let send: SendRow;
  try {
    send = await freeze(c.env, c.config, post, fireAt);
  } catch (err) {
    // A concurrent send-now (the editor and Claude at once) passed the check above too and froze first.
    // The repeat gets the same answer as one that came after it (SPEC §6); a schedule
    // keeps refusing, since its caller asked for a time of its own.
    if (err instanceof HttpError && err.code === "active_send_exists") {
      const winner = await getActiveSendForPost(c.env.DB, post.id);
      if (winner) {
        return repeatAnswer(c, winner.id);
      }
    }
    throw err;
  }
  const frozen: ScheduleResponse = unwrap(await viewWithCursor(c.env, send.id), "send");
  return json(frozen, 201);
}

/** A repeated send-now's answer: the post's active send, marked `idempotent`. */
async function repeatAnswer(c: RequestContext, sendId: string): Promise<Response> {
  const repeat: ScheduleResponse = {
    ...unwrap(await viewWithCursor(c.env, sendId), "send"),
    idempotent: true,
  };
  return json(repeat);
}
