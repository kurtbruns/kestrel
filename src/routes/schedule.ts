/** Post send actions: schedule for a future time, or send now (buffered). Authed. */

import type { ScheduleResponse } from "../../shared/sends";
import { getPost } from "../db/posts";
import { getActiveSendForPost } from "../db/sends";
import { fieldError, readJsonObject } from "../lib/body";
import { json, notFound } from "../lib/errors";
import { unwrap } from "../lib/unwrap";
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
 * can't drift on it (I6). `immediateHint` appends the send-now pointer, which fits the
 * schedule path (a reschedule has no immediate alternative to point at).
 */
export function parseFutureFireAt(
  input: unknown,
  minLeadMs: number,
  immediateHint = false,
): number {
  const hint = immediateHint ? "; use POST /posts/:id/send for the soonest send" : "";
  return acceptFireAt(parseFireAt(input), minLeadMs, { hint });
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
  const fireAt = parseFutureFireAt(body.fire_at, c.config.minLeadMs, true);
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
    const repeat: ScheduleResponse = {
      ...unwrap(await viewWithCursor(c.env, active.id), "send"),
      idempotent: true,
    };
    return json(repeat);
  }

  // The soonest time the lead allows, through the same gate as a schedule, so it lands on
  // the minute at or after it like any other fire time.
  const now = Date.now();
  const fireAt = acceptFireAt(now + c.config.minLeadMs, c.config.minLeadMs, { now });
  const send = await freeze(c.env, c.config, post, fireAt);
  const frozen: ScheduleResponse = unwrap(await viewWithCursor(c.env, send.id), "send");
  return json(frozen, 201);
}
