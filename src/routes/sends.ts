/** Send status surface: list, detail, cancel. Authed. */

import { getPost } from "../db/posts";
import * as sends from "../db/sends";
import { badRequest, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { drainSimulatedWebhooks, simulationActive } from "../providers/simulate";
import { archiveUrl } from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";
import { buildSendProgress } from "../send/progress";
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
  const [progress, outcomes] = await Promise.all([
    sends.deliveryRollup(c.env.DB, send.id),
    sends.deliveryOutcomes(c.env.DB, send.id),
  ]);
  // The archive serves a post's frozen record only once it's sent (drafts/scheduled
  // 404), so the link is live exactly when this send is `sent`. `outcomes` is the
  // sent record view's breakdown (SPEC §8); `progress` is kept for existing callers.
  return json({
    send,
    progress,
    outcomes,
    slug: post?.slug ?? null, // the archive slug — names the CSV export the same way the CSV endpoint does
    archive_url: post ? archiveUrl(c.config, post.slug) : null,
    published: send.status === "sent",
  });
}

/**
 * The cheap poll target for the live in-flight watch (SPEC §8). A single-row read off
 * the denormalized counters (migration 0006) — no aggregate over the audience — plus
 * one indexed retry probe, shaped into dispatch/delivery progress, a derived phase, and
 * the loud attention flags (§11). `deliveries` stays the source of truth; this is its
 * rebuildable cache. Both the watch view and the dashboard active-send widget poll it.
 */
export async function progress(c: RequestContext): Promise<Response> {
  // Dev-only simulation glue: the watch polls this endpoint, so settle any now-due
  // synthetic receipts here too (not just on the cron sweep). That makes the delivery
  // bar advance smoothly as you watch instead of freezing between ticks — mimicking how
  // real provider webhooks arrive continuously. A strict no-op in a deployed env (a real
  // provider is configured there), and never allowed to fail the read.
  if (simulationActive(c.config)) {
    try {
      await drainSimulatedWebhooks(c.env, c.config);
    } catch {
      /* best effort — the progress read must still succeed */
    }
  }
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const hasRetries =
    send.status === "sending" ? await sends.hasActiveRetries(c.env.DB, send.id) : false;
  return json(buildSendProgress(send, c.config.provider, hasRetries, Date.now()));
}

/** Quote a CSV field when it contains a comma, quote, or newline (RFC 4180). */
function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The sent record's per-recipient delivery data as CSV (SPEC §8, §11 "always
 * inspectable"). Read-only over the frozen record (I3) — one row per recipient of
 * the frozen audience, with the send-loop status and the later webhook event.
 */
export async function deliveriesCsv(c: RequestContext): Promise<Response> {
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const [post, rows] = await Promise.all([
    getPost(c.env.DB, send.post_id),
    sends.listDeliveries(c.env.DB, send.id),
  ]);
  const header = ["email", "status", "event", "event_at", "error"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.email),
        csvCell(r.status),
        csvCell(r.event),
        csvCell(r.event_at != null ? new Date(r.event_at).toISOString() : ""),
        csvCell(r.error),
      ].join(","),
    );
  }
  const filename = `${post?.slug ?? "send"}-deliveries.csv`;
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
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
