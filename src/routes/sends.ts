/** Send status surface: list, detail, cancel. Authed. */

import { getPost } from "../db/posts";
import * as sends from "../db/sends";
import { badRequest, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { archiveUrl } from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";
import { resolveStuckSend } from "../send/resolve";
import { cancel as cancelSend } from "../send/schedule";

export async function list(c: RequestContext): Promise<Response> {
  const statusParam = c.url.searchParams.get("status") ?? undefined;
  const valid: sends.SendStatus[] = ["scheduled", "sending", "sent", "canceled", "failed"];
  const status = valid.includes(statusParam as sends.SendStatus)
    ? (statusParam as sends.SendStatus)
    : undefined;
  const search = c.url.searchParams.get("search") ?? undefined;
  const filter = { status, search } satisfies sends.SendFilter;
  const page = parseListParams(c.url, sends.SEND_LIST_SPEC);
  const [total, rows] = await Promise.all([
    sends.countSends(c.env.DB, filter),
    sends.listSends(c.env.DB, filter, page),
  ]);
  const withProgress = await Promise.all(
    rows.map(async (s) => ({ ...s, progress: await sends.deliveryRollup(c.env.DB, s.id) })),
  );
  return json({ sends: withProgress, page: listPage(total, page) });
}

export async function get(c: RequestContext): Promise<Response> {
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const post = await getPost(c.env.DB, send.post_id);
  const progress = await sends.deliveryRollup(c.env.DB, send.id);
  return json({
    send,
    progress,
    archive_url: post ? archiveUrl(c.config, post.slug) : null,
  });
}

export async function cancel(c: RequestContext): Promise<Response> {
  const send = await cancelSend(c.env, param(c, "id"));
  return json({ send });
}

/**
 * Adjudicate a send wedged on ambiguous (`dispatched`) deliveries — the one manual
 * step for the stuck state the sweep flags but can't clear on its own (SPEC §11).
 */
export async function resolve(c: RequestContext): Promise<Response> {
  let body: { resolution?: unknown };
  try {
    body = (await c.req.json()) as { resolution?: unknown };
  } catch {
    throw badRequest("JSON body with 'resolution' ('failed' | 'accepted') is required");
  }
  const outcome = body.resolution;
  if (outcome !== "failed" && outcome !== "accepted") {
    throw badRequest("resolution must be 'failed' or 'accepted'");
  }
  const actor = c.principal?.email ?? "service";
  const result = await resolveStuckSend(c.env, param(c, "id"), outcome, actor);
  return json(result);
}
