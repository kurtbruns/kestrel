/** Post send actions: schedule for a future time, or send now (buffered). Authed. */

import type { ScheduleResponse } from "../../shared/sends";
import { readBack } from "../../shared/time_zone";
import { getPost } from "../db/posts";
import { getActiveSendForPost, renderWarnings, type SendRow } from "../db/sends";
import { readTimeZone } from "../db/settings";
import { fieldError, readJsonObject } from "../lib/body";
import { HttpError, json, notFound } from "../lib/errors";
import { unwrap } from "../lib/unwrap";
import { requireConnectedProvider } from "../providers";
import type { RequestContext } from "../router";
import { actorOf, param } from "../router";
import { viewWithCursor } from "../send/describe";
import { parseFireAtRequest, resolveFireAt } from "../send/fire_at";
import { acceptFireAt, activeSendExists, freeze, requireTimeZone } from "../send/schedule";
import { carryingPost } from "../services/post_view";
import { readSettingsBody, resolveSettings, type SettingsBody } from "./post_settings";
import { carryingSettings } from "./settings";

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

/** A refusal about the post or the settings a freeze read carries that resource as it stands. */
function carryingResources(c: RequestContext, act: () => Promise<Response>): Promise<Response> {
  return carryingPost(c.env, c.config, param(c, "id"), () => carryingSettings(c, act));
}

export function schedule(c: RequestContext): Promise<Response> {
  return carryingResources(c, () => scheduleOnce(c));
}

export function sendNow(c: RequestContext): Promise<Response> {
  return carryingResources(c, () => sendNowOnce(c));
}

async function scheduleOnce(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }

  const body = await readJsonObject(c);
  rejectStrayTemplateChoice(body);
  const fields = readSettingsBody(body);
  const request = parseFireAtRequest(body.fire_at, body.time_zone);
  requireConnectedProvider(c.config);
  const zone = await requireTimeZone(c.env.DB);
  // Read on the zone's clock, then held to the one gate every fire time passes (I6).
  const requested = resolveFireAt(request, zone);
  const fireAt = acceptFireAt(requested.at, c.config.minLeadMs);
  // A draft has no started send, so its address can still change.
  const settings = await resolveSettings(c.env.DB, post, fields);
  const by = actorOf(unwrap(c.principal, "principal"));
  const send = await freeze(
    c.env,
    c.config,
    post,
    fireAt,
    settings,
    { act: "schedule", by },
    requested.local,
  );
  return json(await frozenAnswer(c, send, zone), 201);
}

async function sendNowOnce(c: RequestContext): Promise<Response> {
  const post = await getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  // Send-now needs no body, so an empty one needs no content type; one that is sent is
  // read like any other JSON body: to refuse a stray template choice, and for the settings.
  const body = await readJsonObject(c, { optional: true });
  rejectStrayTemplateChoice(body);
  const fields = readSettingsBody(body);

  // Idempotent: if a send is already in flight for this post, return it. A repeat changes
  // nothing, its settings included: they have their own route.
  const active = await getActiveSendForPost(c.env.DB, post.id);
  if (active) {
    return repeatAnswer(c, active, fields);
  }

  requireConnectedProvider(c.config);
  const zone = await requireTimeZone(c.env.DB);
  // The soonest time the lead allows, through the same gate as a schedule, so it lands on
  // the minute at or after it like any other fire time.
  const now = Date.now();
  const fireAt = acceptFireAt(now + c.config.minLeadMs, c.config.minLeadMs, { now });
  const settings = await resolveSettings(c.env.DB, post, fields);
  const by = actorOf(unwrap(c.principal, "principal"));
  let send: SendRow;
  try {
    send = await freeze(c.env, c.config, post, fireAt, settings, { act: "send_now", by });
  } catch (err) {
    // A concurrent send-now (the editor and Claude at once) passed the check above too and froze first.
    // The repeat gets the same answer as one that came after it (SPEC §6); a schedule
    // keeps refusing, since its caller asked for a time of its own.
    if (err instanceof HttpError && err.code === "active_send_exists") {
      const winner = await getActiveSendForPost(c.env.DB, post.id);
      if (winner) {
        return repeatAnswer(c, winner, fields);
      }
    }
    throw err;
  }
  return json(await frozenAnswer(c, send, zone), 201);
}

/** A schedule's or send-now's answer: the send as it now stands, what the render said about
 *  the copy it froze (SPEC §5), so a caller learns of a missing image before it tests, and how
 *  its fire time reads on the publication's clock (SPEC §6). */
async function frozenAnswer(
  c: RequestContext,
  send: SendRow,
  zone: string | null,
): Promise<ScheduleResponse> {
  const read = unwrap(await viewWithCursor(c.env, send.id), "send");
  return {
    ...read,
    warnings: renderWarnings(send),
    read_back: readBack(read.send.fire_at, zone, read.send.as_of),
  };
}

/**
 * A repeated send-now's answer: the post's active send, marked `idempotent`. A repeat changes
 * nothing, so one asking for settings the post doesn't have is refused with that send
 * (`active_send_exists`) rather than answered as if it had them: a client that asked for email
 * only would otherwise read success while the post goes out listed (SPEC §5).
 */
async function repeatAnswer(
  c: RequestContext,
  send: SendRow,
  fields: SettingsBody,
): Promise<Response> {
  // Read again: the send this repeats may have set them as it froze.
  const post = unwrap(await getPost(c.env.DB, param(c, "id")), "post");
  const differs =
    (fields.emailOnly !== undefined && fields.emailOnly !== post.email_only) ||
    (fields.slug !== undefined && fields.slug !== post.slug) ||
    (fields.slugAuto !== undefined && fields.slugAuto !== post.slug_auto);
  if (differs) {
    throw await activeSendExists(c.env, send);
  }
  // A repeat finds the send before the zone is required, so it reads on whatever clock is set.
  const zone = await readTimeZone(c.env.DB);
  const repeat: ScheduleResponse = { ...(await frozenAnswer(c, send, zone)), idempotent: true };
  return json(repeat);
}
