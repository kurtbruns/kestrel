/** Send status surface: list, detail, the feed pages follow, cancel. Authed. */

import { decodeSendCursor, encodeSendCursor, type SendCursor } from "../../shared/cursor";
import type {
  DeliveryListResponse,
  SendActionResponse,
  SendFeedResponse,
  SendListResponse,
  SendResponse,
} from "../../shared/sends";
import { getPost } from "../db/posts";
import * as sends from "../db/sends";
import { oneOf, readJsonObject } from "../lib/body";
import { badRequest, HttpError, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { archiveUrl } from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";
import { feedPace, readAgainAt, SETTLE_FOLLOW_MS } from "../send/feed";
import { buildLiveSend, buildSendProgress } from "../send/progress";
import { resolveStuckSend } from "../send/resolve";
import { cancel as cancelSend, reschedule as rescheduleSend } from "../send/schedule";
import { parseFutureFireAt } from "./schedule";

export async function list(c: RequestContext): Promise<Response> {
  const statusParam = c.url.searchParams.get("status") ?? undefined;
  const valid: sends.SendStatus[] = ["scheduled", "sending", "sent", "canceled"];
  const status = valid.includes(statusParam as sends.SendStatus)
    ? (statusParam as sends.SendStatus)
    : undefined;
  const search = c.url.searchParams.get("search") ?? undefined;
  // "only" narrows to sends with a delivery failure (any bounce / complaint / unsent).
  const failures = c.url.searchParams.get("failures") === "only" ? "only" : undefined;
  const filter = { status, search, failures } satisfies sends.SendFilter;
  const page = parseListParams(c.url, sends.SEND_LIST_SPEC);
  // One moment for the whole page: the rows' derived fields and the cursor's read time.
  // Taken before the read, so anything the clock changes after it is still ahead of the
  // cursor.
  const now = Date.now();
  const { rows, total, seq } = await sends.listSendsPage(c.env.DB, filter, page);
  // Every row carries the denormalized c_* counters and its retry probe, so each row's
  // phase and attention come from `buildSendProgress` exactly as `/progress` builds them,
  // with no aggregate over deliveries and no read per row (SPEC §8). The server derives;
  // no client keeps a threshold or a phase rule of its own.
  const body: SendListResponse = {
    sends: rows.map(({ has_retries, ...s }) => {
      const { phase, attention } = buildSendProgress(s, c.config.provider, has_retries === 1, now);
      return { ...s, phase, attention, stuck: attention.stuck };
    }),
    page: listPage(total, page),
    cursor: encodeSendCursor({ seq, at: now }),
  };
  return json(body);
}

export async function get(c: RequestContext): Promise<Response> {
  // The sequence and its time come first, so whatever the send shows is at or after its
  // cursor, and a client following it from here misses nothing.
  const now = Date.now();
  const seq = await sends.currentSendSeq(c.env.DB);
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
  const body: SendResponse = {
    send,
    progress,
    outcomes,
    slug: post?.slug ?? null, // the archive slug — names the CSV export the same way the CSV endpoint does
    // Only a sent send's post is on the archive; before then the link would 404.
    archive_url: post && send.status === "sent" ? archiveUrl(c.config, post.slug) : null,
    published: send.status === "sent",
    cursor: encodeSendCursor({ seq, at: now }),
  };
  return json(body);
}

/**
 * The cheap poll target for the live in-flight watch (SPEC §8). A single-row read off
 * the denormalized counters (`sends.c_*`) — no aggregate over the audience — plus
 * one indexed retry probe, shaped into dispatch/delivery progress, a derived phase, and
 * the loud attention flags (§12). `deliveries` stays the source of truth; this is its
 * rebuildable cache. Reading it changes nothing: locally, simulated receipts arrive on
 * the dev ticker's own clock, whether or not a watch is open (SPEC §10).
 */
export async function progress(c: RequestContext): Promise<Response> {
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  const hasRetries =
    send.status === "sending" ? await sends.hasActiveRetries(c.env.DB, send.id) : false;
  return json(buildSendProgress(send, c.config.provider, hasRetries, Date.now()));
}

/** The `since` cursor, or null when none is given; a 400 naming the field for one this
 *  server did not issue. */
function parseSince(raw: string | null): SendCursor | null {
  if (raw === null) {
    return null;
  }
  const cursor = decodeSendCursor(raw);
  if (!cursor) {
    throw badRequest("since is not a cursor from this API", { field: "since" });
  }
  return cursor;
}

/** How many changes one feed read reports at most, by default and at the most a client may ask. */
export const FEED_DEFAULT_LIMIT = 100;
export const FEED_MAX_LIMIT = 500;

/** How far a cursor's read time may run ahead of this server's clock before it is refused:
 *  a margin for clocks that differ a little between the places a request is served. */
const CURSOR_CLOCK_SLACK_MS = 60_000;

/** The feed's `limit`: a whole number from 1 to the most, or a 400 naming the field. */
function parseFeedLimit(raw: string | null): number {
  if (raw === null) {
    return FEED_DEFAULT_LIMIT;
  }
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > FEED_MAX_LIMIT) {
    throw badRequest(`limit must be a whole number from 1 to ${FEED_MAX_LIMIT}`, {
      field: "limit",
    });
  }
  return n;
}

/**
 * What a client follows to keep up with sends (SPEC §8): with `since`, every send that
 * changed after that cursor, whatever its state, those the clock changed with no write
 * included, and every send removed after it; without it, every send that can change on its
 * own. Each is in the `/progress` shape, beside a new cursor and when to read again
 * (`readAgainAt`). One read of send rows, never of the delivery record, and reading it
 * changes nothing.
 *
 * A cursor ahead of this database (a sequence above the current one, or a read time after
 * now) is from a database since reset or restored: nothing after it would ever be reported,
 * so it is refused with `cursor_ahead`, and the client reads its sends afresh.
 */
export async function feed(c: RequestContext): Promise<Response> {
  const since = parseSince(c.url.searchParams.get("since"));
  const limit = parseFeedLimit(c.url.searchParams.get("limit"));
  // Taken before the read, so a threshold the clock crosses after it is still ahead of the
  // cursor this read hands back.
  const now = Date.now();
  const read = await sends.sendFeed(
    c.env.DB,
    now,
    since,
    now - SETTLE_FOLLOW_MS,
    { missedMs: MISSED_THRESHOLD_MS, stuckMs: STUCK_THRESHOLD_MS },
    limit,
  );
  if (since && (since.seq > read.current || since.at > now + CURSOR_CLOCK_SLACK_MS)) {
    throw new HttpError(
      409,
      "cursor_ahead",
      "since is ahead of this database (reset or restored since the cursor was read); read the sends again and follow from that read's cursor",
      { field: "since", cursor: encodeSendCursor({ seq: read.current, at: now }) },
    );
  }
  const pace = feedPace(read.unfinished, read.settlingSince, now);
  const body: SendFeedResponse = {
    now,
    sends: read.rows.map(({ has_retries, ...row }) =>
      buildLiveSend(row, c.config.provider, has_retries === 1, now),
    ),
    removed: read.removed,
    cursor: encodeSendCursor({ seq: read.seq, at: now }),
    more: read.more,
    // With more waiting, at once; otherwise the pace.
    read_again_at: read.more ? now : readAgainAt(pace, now),
  };
  return json(body);
}

/** The `view` query param, defaulting to `failures` (the record view opens on the rows
 *  that went wrong); one outside the recognized set is a 400 naming the field. */
function parseDeliveryView(raw: string | null): sends.DeliveryView {
  if (raw === null) {
    return "failures";
  }
  if (!sends.DELIVERY_VIEWS.includes(raw as sends.DeliveryView)) {
    throw badRequest(`view must be one of ${sends.DELIVERY_VIEWS.join(", ")}`, { field: "view" });
  }
  return raw as sends.DeliveryView;
}

/**
 * The sent record's per-recipient rows as paginated JSON (SPEC §8, §12 "always
 * inspectable"). Reads the `deliveries` rows DIRECTLY — the source of truth — not the
 * `c_*` progress counters, so it is heavier than `/progress` and deliberately NOT the
 * poll target. Filter by `view` (failures / delivered / all / a single bucket) and an
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
  const body: DeliveryListResponse = { deliveries: rows, view, page: listPage(total, page) };
  return json(body);
}

/**
 * One CSV field. A text cell a spreadsheet would read as a formula (one starting with
 * `=`, `+`, `-`, `@`, a tab, or a carriage return) is prefixed with `'` so it opens as
 * text: an address like `=HYPERLINK(…)@example.com` is valid, and the export is opened
 * by the publisher. Then quoted when it contains a comma, quote, or newline (RFC 4180).
 */
function csvCell(value: string | number | null): string {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The sent record's per-recipient delivery data as CSV (SPEC §8, §12 "always
 * inspectable"). Read-only over the frozen record (I3) — one row per recipient of
 * the audience at fire, with the send-loop status and the later webhook event.
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
  const body: SendActionResponse = { send };
  return json(body);
}

/**
 * Move a scheduled send's fire time without re-freezing the render (SPEC §6). The
 * frozen bytes are untouched (I3; the audience is resolved when the send fires, not
 * here) and the review window is preserved (I6) — only `fire_at` moves. Same
 * minimum-lead guard as scheduling, and
 * `scheduled`-status only (the state machine's CAS enforces the latter, I6).
 */
export async function reschedule(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const fireAt = parseFutureFireAt(body.fire_at, c.config.minLeadMs);
  const send = await rescheduleSend(c.env, param(c, "id"), fireAt);
  const response: SendActionResponse = { send };
  return json(response);
}

/**
 * Adjudicate a send wedged on ambiguous (`dispatched`) deliveries — the one manual
 * step for the stuck state the sweep flags but can't clear on its own (SPEC §12).
 */
export async function resolve(c: RequestContext): Promise<Response> {
  const outcome = oneOf(await readJsonObject(c), "resolution", ["unsent", "accepted"]);
  const actor = c.principal?.email ?? "service";
  const result = await resolveStuckSend(c.env, param(c, "id"), outcome, actor);
  return json(result);
}
