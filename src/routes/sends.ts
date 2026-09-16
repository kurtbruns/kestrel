/** Send status surface: list, detail, cancel. Authed. */

import { getPost } from "../db/posts";
import * as sends from "../db/sends";
import { badRequest, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { SEND_NOW_BUFFER_MS } from "../lib/time";
import { drainSimulatedWebhooks, simulationActive } from "../providers/simulate";
import { archiveUrl } from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";
import { buildSendProgress } from "../send/progress";
import { resolveStuckSend } from "../send/resolve";
import { cancel as cancelSend, reschedule as rescheduleSend } from "../send/schedule";
import { parseFireAt } from "./schedule";

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
  // Every row already carries the denormalized c_* counters (SEND_LIST_COLS), so the
  // list surfaces dispatch/delivery progress and the wedged signal straight off the row.
  // The per-row `deliveryRollup` aggregate this once ran — an O(rows × audience) scan on
  // every Sent-page load and every ~3s active-send poll — is exactly what the counters
  // (migration 0006) make redundant, so it is gone (#166). `deliveries` stays the source
  // of truth; the counters are its rebuildable cache (SPEC §8).
  return json({ sends: rows, page: listPage(total, page) });
}

export async function get(c: RequestContext): Promise<Response> {
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const post = await getPost(c.env.DB, send.post_id);
  const [outcomes, hasRetries] = await Promise.all([
    sends.deliveryOutcomes(c.env.DB, send.id),
    send.status === "sending" ? sends.hasActiveRetries(c.env.DB, send.id) : Promise.resolve(false),
  ]);
  // The archive serves a post's frozen record only once it's sent (drafts/scheduled
  // 404), so the link is live exactly when this send is `sent`. `outcomes` is the sent
  // record view's per-recipient delivery breakdown (SPEC §8). `progress` is the same
  // single-row counter shape `/progress` reports (buildSendProgress) — consolidated onto
  // the c_* counters so this detail read no longer runs the redundant deliveryRollup
  // aggregate (#166); it decides nothing and mails no one (I3).
  const progress = buildSendProgress(send, c.config.provider, hasRetries, Date.now());
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

/** Validate the `view` query param against the recognized set, defaulting to `issues`
 *  (the record view opens on the rows that went wrong). */
function parseDeliveryView(raw: string | null): sends.DeliveryView {
  return sends.DELIVERY_VIEWS.includes(raw as sends.DeliveryView)
    ? (raw as sends.DeliveryView)
    : "issues";
}

/**
 * The sent record's per-recipient rows as paginated JSON (SPEC §8, §11 "always
 * inspectable"). Reads the `deliveries` rows DIRECTLY — the source of truth — not the
 * `c_*` progress counters, so it is heavier than `/progress` and deliberately NOT the
 * poll target. Filter by `view` (issues / delivered / all / a single bucket) and an
 * optional email search; sort and paginate via the shared list convention. Read-only
 * over the frozen record (I3) — it decides nothing and mails no one.
 */
export async function deliveries(c: RequestContext): Promise<Response> {
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const view = parseDeliveryView(c.url.searchParams.get("view"));
  const search = c.url.searchParams.get("search") ?? undefined;
  const page = parseListParams(c.url, sends.DELIVERY_LIST_SPEC);
  const [total, rows] = await Promise.all([
    sends.countDeliveriesFiltered(c.env.DB, send.id, view, search),
    sends.listDeliveriesPage(c.env.DB, send.id, view, page, search),
  ]);
  return json({ deliveries: rows, view, page: listPage(total, page) });
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
 * Move a scheduled send's fire time without re-freezing the render (SPEC §6). The
 * frozen bytes and the frozen audience are untouched (I3) and the review window is
 * preserved (I6) — only `fire_at` moves. Same minimum-lead guard as scheduling, and
 * `scheduled`-status only (the state machine's CAS enforces the latter, I6).
 */
export async function reschedule(c: RequestContext): Promise<Response> {
  let body: { fire_at?: unknown };
  try {
    body = (await c.req.json()) as { fire_at?: unknown };
  } catch {
    throw badRequest("JSON body with 'fire_at' is required");
  }
  const fireAt = parseFireAt(body.fire_at);
  if (fireAt < Date.now() + SEND_NOW_BUFFER_MS) {
    throw badRequest(
      `fire_at must be at least ${SEND_NOW_BUFFER_MS / 60000} minutes in the future`,
    );
  }
  const send = await rescheduleSend(c.env, param(c, "id"), fireAt);
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
