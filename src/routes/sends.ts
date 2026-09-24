/** Send status surface: list, detail, the feed pages follow, cancel. Authed. */

import { decodeSendCursor, encodeSendCursor, type SendCursor } from "../../shared/cursor";
import {
  BOUNCE_SPIKE_RECENT_MS,
  type DeliveryListResponse,
  type FeedCondition,
  type ResolveResponse,
  type SendActionResponse,
  type SendFeedResponse,
  type SendListResponse,
  type SendResponse,
  type SendView,
} from "../../shared/sends";
import { getPost } from "../db/posts";
import * as sends from "../db/sends";
import { oneOf, optCount, readJsonObject } from "../lib/body";
import { badRequest, HttpError, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { POST_PAGE_SECURITY_HEADERS } from "../lib/page_headers";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import type { RequestContext } from "../router";
import { param } from "../router";
import { bySeverity, sendConditions } from "../send/conditions";
import { viewWithCursor } from "../send/describe";
import { feedPace, readAgainAt, SETTLE_FOLLOW_MS } from "../send/feed";
import { resolveStuckSend } from "../send/resolve";
import { cancel as cancelSend, reschedule as rescheduleSend } from "../send/schedule";
import { buildSendView } from "../send/view";
import { parseFireAt } from "./schedule";

/** The `GET /sends` filters: each a value from its set, or absent; anything else is a 400
 *  naming the field. */
function parseSendFilter(url: URL): sends.SendFilter {
  const q = url.searchParams;
  const status = q.get("status");
  const statuses: sends.SendStatus[] = ["scheduled", "sending", "sent", "canceled"];
  if (status !== null && !statuses.includes(status as sends.SendStatus)) {
    throw badRequest(`status must be one of ${statuses.join(", ")}`, { field: "status" });
  }
  const failures = q.get("failures");
  if (failures !== null && failures !== "only") {
    throw badRequest("failures must be only", { field: "failures" });
  }
  return {
    status: (status as sends.SendStatus | null) ?? undefined,
    search: q.get("search") ?? undefined,
    failures: failures === "only" ? "only" : undefined,
  };
}

export async function list(c: RequestContext): Promise<Response> {
  const filter = parseSendFilter(c.url);
  const page = parseListParams(c.url, sends.SEND_LIST_SPEC);
  // One moment for the whole page: the rows' derived fields and the cursor's read time.
  // Taken before the read, so anything the clock changes after it is still ahead of the
  // cursor.
  const now = Date.now();
  const { rows, total, seq } = await sends.listSendsPage(c.env.DB, filter, page);
  // Every row carries the denormalized c_* counters and its retry probe, so each row's
  // phase, conditions, and actions come from the same rules as `/progress`, with no
  // aggregate over deliveries and no read per row (SPEC §8). The server derives; no client
  // keeps a threshold or a phase rule of its own.
  const body: SendListResponse = {
    sends: rows.map(({ has_retries, ...s }) => buildSendView(s, c.config, has_retries === 1, now)),
    page: listPage(total, page),
    cursor: encodeSendCursor({ seq, at: now }),
  };
  return json(body);
}

/**
 * The entity tag of a send's view: its `rev`, and what the clock derives from it (the
 * phase, each condition and its words, the actions, the next change), so a 304 means
 * nothing about the send has changed since, written or derived: a fire time passing turns
 * a `scheduled` view `due` with no write, and a missed or stuck send's words count its
 * minutes. Only `as_of` is left out. `If-Match` reads the `rev`.
 */
function sendEtag(view: SendView): string {
  const derived = [
    view.phase,
    view.conditions.map((cond) => `${cond.kind}:${cond.message}`).join(","),
    view.actions.map((act) => act.name).join(","),
    String(view.next_change_at),
  ].join(";");
  let h = 0;
  for (let i = 0; i < derived.length; i++) {
    h = (Math.imul(h, 31) + derived.charCodeAt(i)) | 0;
  }
  return `"${view.rev}-${(h >>> 0).toString(36)}"`;
}

/**
 * One send: its view, the delivery-outcome breakdown of its record (SPEC §8), and the
 * cursor to follow it from with `GET /sends/feed`. Tagged with `ETag` (`sendEtag`); a
 * request whose `If-None-Match` still matches is answered 304 before the outcomes are
 * counted, so a client re-reading the send pays for the aggregate only when it changed.
 */
export async function get(c: RequestContext): Promise<Response> {
  const id = param(c, "id");
  // The sequence and its time come first (`viewWithCursor`), so whatever the send shows is
  // at or after its cursor, and a client following it from here misses nothing.
  const read = await viewWithCursor(c.env, id);
  if (!read) {
    throw notFound("send");
  }
  const { send, cursor } = read;
  const etag = sendEtag(send);
  // The router marks every admin answer `no-store`; the tag is for a client that sends
  // `If-None-Match` itself.
  const headers = { etag };
  const match = c.req.headers.get("if-none-match");
  if (match?.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
    return new Response(null, { status: 304, headers });
  }
  const body: SendResponse = { send, outcomes: await sends.deliveryOutcomes(c.env.DB, id), cursor };
  return json(body, 200, headers);
}

/**
 * The frozen email a send holds (I3), as it will fire or went out: `format=html` (the
 * default) or `format=text`, with the per-recipient placeholders left unfilled. Its own
 * route, so a view of the send never carries the bodies.
 */
export async function email(c: RequestContext): Promise<Response> {
  const format = c.url.searchParams.get("format") ?? "html";
  if (format !== "html" && format !== "text") {
    throw badRequest("format must be html or text", { field: "format" });
  }
  const send = await sends.getSend(c.env.DB, param(c, "id"));
  if (!send) {
    throw notFound("send");
  }
  return format === "html"
    ? new Response(send.rendered_html, {
        headers: { ...POST_PAGE_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
      })
    : new Response(send.rendered_text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
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
    now - BOUNCE_SPIKE_RECENT_MS,
  );
  if (since && (since.seq > read.current || since.at > now + CURSOR_CLOCK_SLACK_MS)) {
    throw new HttpError(
      409,
      "cursor_ahead",
      "since is ahead of this database (reset or restored since the cursor was read); read the sends again and follow from that read's cursor",
      { field: "since", cursor: encodeSendCursor({ seq: read.current, at: now }) },
    );
  }
  const pace = feedPace(
    read.open.filter((s) => s.status === "scheduled" || s.status === "sending"),
    read.settlingSince,
    now,
  );
  // Every open problem in one read, whichever sends it is on and whether they changed.
  const conditions: FeedCondition[] = read.open
    .flatMap((s) =>
      sendConditions(s, now).map((cond) => ({ ...cond, send_id: s.id, subject: s.subject })),
    )
    .sort(bySeverity);
  const body: SendFeedResponse = {
    now,
    sends: read.rows.map(({ has_retries, ...row }) =>
      buildSendView(row, c.config, has_retries === 1, now),
    ),
    removed: read.removed,
    cursor: encodeSendCursor({ seq: read.seq, at: now }),
    more: read.more,
    conditions,
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

/** An action's answer: the send as it now stands, and the cursor to follow it from. */
async function answerWith(c: RequestContext, id: string) {
  const read = await viewWithCursor(c.env, id);
  if (!read) {
    throw notFound("send");
  }
  return read;
}

/**
 * The `If-Match` header of an action: the `rev` the caller last read, as `"<rev>"`, bare,
 * or `GET /sends/:id`'s `ETag`, or undefined when absent. Anything else is a 400 naming it.
 */
function parseIfMatch(c: RequestContext): number | undefined {
  const raw = c.req.headers.get("if-match");
  if (raw === null) {
    return undefined;
  }
  // The bare rev, or `GET /sends/:id`'s ETag (the rev, then a tag of what the clock
  // derives), whose rev is what an action compares.
  const match = /^\s*(?:W\/)?"?(\d+)(?:-[0-9a-z]+)?"?\s*$/.exec(raw);
  const rev = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(rev)) {
    throw badRequest('If-Match must be a send\'s rev, as "<rev>"', { field: "If-Match" });
  }
  return rev;
}

export async function cancel(c: RequestContext): Promise<Response> {
  const id = param(c, "id");
  const { changed } = await cancelSend(c.env, id, { ifMatch: parseIfMatch(c) });
  const body: SendActionResponse = { ...(await answerWith(c, id)), changed };
  return json(body);
}

/**
 * Move a scheduled send's fire time without re-freezing the render (SPEC §6). The
 * frozen bytes are untouched (I3; the audience is resolved when the send fires, not
 * here) and the review window is preserved (I6) — only `fire_at` moves. Same
 * minimum-lead guard as scheduling, and only inside the review window (the state
 * machine's CAS enforces the latter, I6).
 */
export async function reschedule(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const fireAt = parseFireAt(body.fire_at);
  const id = param(c, "id");
  const { changed } = await rescheduleSend(c.env, id, fireAt, c.config.minLeadMs, {
    ifMatch: parseIfMatch(c),
  });
  const response: SendActionResponse = { ...(await answerWith(c, id)), changed };
  return json(response);
}

/**
 * Adjudicate a send wedged on ambiguous (`dispatched`) deliveries — the one manual
 * step for the stuck state the sweep flags but can't clear on its own (SPEC §12).
 */
export async function resolve(c: RequestContext): Promise<Response> {
  const request = await readJsonObject(c);
  const outcome = oneOf(request, "resolution", ["unsent", "accepted"]);
  const expectedCount = optCount(request, "expected_count");
  const actor = c.principal?.email ?? "service";
  const id = param(c, "id");
  const { resolved, completed } = await resolveStuckSend(c.env, id, outcome, actor, {
    ifMatch: parseIfMatch(c),
    expectedCount,
  });
  const body: ResolveResponse = { ...(await answerWith(c, id)), resolved, completed };
  return json(body);
}
