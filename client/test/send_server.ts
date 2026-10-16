// A scripted send server for client specs: the sends a page and the send_state layer read,
// answered over `fakeApi` the way the Worker answers `GET /api/sends`, `GET /api/sends/feed`,
// and `GET /api/sends/:id`, with the builders for what those routes carry (`sendView`,
// `condition`). Imported by specs only; never part of the bundle.

import { decodeSendCursor, encodeSendCursor } from "../../shared/cursor";
import {
  refusalAdvice,
  refusedMessage,
  type SendAction,
  type SendCondition,
  type SendFeedResponse,
  type SendListResponse,
  type SendPhase,
  type SendResponse,
  type SendSummary,
  type SendView,
} from "../../shared/sends";
import { type FakeApi, type FakeRequest, type FakeRoute, jsonResponse } from "./support";

/** What a scripted send carries beyond its row: what the server would derive for it. */
export interface SendExtras {
  /** The phase, when not the one a spec's plain row implies (see `sendServer`). */
  phase?: SendPhase;
  /** Conditions beyond the ones a plain row implies (missed by the clock, refused by an
   *  account halt): a wedge, a stuck send, a bounce spike, as `condition` builds them. */
  conditions?: SendCondition[];
  /** The actions, when not the ones the clock implies: a read whose clock disagrees with
   *  the page's, or a server that withholds one. */
  actions?: SendAction[];
  eta_ms?: number | null;
  /** The published post's page, which the server links once the send has started. */
  archive?: string | null;
  /** The post's listing (SPEC §5), when it is email only. */
  email_only?: boolean;
  /** Which address the send's email carries, `archive` for a send frozen before unlisted links. */
  web_link?: "unlisted" | "archive";
}

/**
 * A stored send row as the API carries it, a `SendView`, for a spec's scripted sends: the
 * facts carried over, the counts from the counters, the audience from `recipient_count`,
 * and plain derived fields (a phase from the status, no conditions or actions) that `over`
 * replaces where a spec needs them.
 */
export function sendView(row: SendSummary, over: Partial<SendView> = {}): SendView {
  const counts = {
    pending: row.c_pending,
    in_flight: row.c_in_flight,
    accepted: row.c_accepted,
    delivered: row.c_delivered,
    bounced: row.c_bounced,
    complained: row.c_complained,
    skipped: row.c_skipped,
    unsent: row.c_unsent,
  };
  return {
    id: row.id,
    post_id: row.post_id,
    subject: row.subject,
    status: row.status,
    email_only: false,
    web_link: "unlisted",
    rev: row.rev,
    as_of: Date.now(),
    fire_at: row.fire_at,
    scheduled_at: row.scheduled_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    remade_at: row.remade_at,
    tested_at: row.tested_at,
    audience: {
      count: row.recipient_count,
      fixed: row.audience_resolved_at !== null,
      fixed_at: row.audience_resolved_at,
    },
    counts,
    dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: null },
    delivery: {
      confirmed: row.c_delivered + row.c_bounced + row.c_complained,
      percent_of_accepted: 0,
    },
    provider: {
      name: "fake",
      halt:
        row.status === "sending" && row.halt_reason
          ? {
              reason: row.halt_reason,
              cause: row.halt_cause,
              error: row.halt_error ?? "",
              retries: row.halt_retries,
              since: row.halted_at,
              retry_at: row.halt_retry_at,
            }
          : null,
    },
    phase:
      row.status === "sending"
        ? "progressing"
        : row.status === "sent"
          ? row.c_accepted > 0
            ? "settling"
            : "complete"
          : row.status,
    conditions: [],
    actions: [],
    next_change_at: null,
    links: {
      self: `/api/sends/${row.id}`,
      email_html: `/api/sends/${row.id}/email?format=html`,
      email_text: `/api/sends/${row.id}/email?format=text`,
      deliveries: `/api/sends/${row.id}/deliveries`,
      deliveries_csv: `/api/sends/${row.id}/deliveries.csv`,
      post: `/api/posts/${row.post_id}`,
      archive:
        row.status === "sending" || row.status === "sent"
          ? `https://birds.example/${row.post_id}`
          : null,
      unlisted:
        row.status === "sending" || row.status === "sent"
          ? `https://app.birds.example/email/t-${row.post_id}`
          : null,
    },
    ...over,
  };
}

/** Conditions as the server words them, for a spec's scripted sends. */
export const condition = {
  wedged: (count: number, id = "x"): SendCondition => ({
    kind: "wedged",
    severity: "action",
    since: null,
    message: `The provider never answered for ${count} recipient${count === 1 ? "" : "s"}, so whether they were mailed is unknown.`,
    action: { name: "resolve", method: "POST", path: `/api/sends/${id}/resolve` },
    count,
  }),
  /** The provider unavailable; `selfThrottled` as the server marks a rate limit the
   *  deployment causes itself (SPEC §12). */
  unavailable: (selfThrottled: boolean): SendCondition => ({
    kind: "provider_unavailable",
    severity: selfThrottled ? "warn" : "info",
    since: 1_000,
    message: selfThrottled
      ? "The provider keeps refusing for its sending rate: Maximum sending rate exceeded. Whoever runs the deployment sets SES_MAX_SEND_RATE."
      : "The provider is unavailable: ses 503.",
    action: null,
    error: selfThrottled ? "Maximum sending rate exceeded." : "ses 503",
    retry_at: null,
  }),
  stuck: (): SendCondition => ({
    kind: "stuck",
    severity: "warn",
    since: null,
    message:
      "Nothing has gone out for 31 minutes, with no retry or provider problem to explain it.",
    action: null,
  }),
  refused: (error: string, retryAt: number | null): SendCondition => ({
    kind: "refused",
    severity: "action",
    since: 1_000,
    message: `The provider is refusing the account: ${error} Whoever runs the deployment replaces the SES access key in its secrets, or gives the key ses:SendEmail and ses:SendBulkEmail in its IAM policy.`,
    action: null,
    cause: "credentials",
    error,
    advice:
      "Whoever runs the deployment replaces the SES access key in its secrets, or gives the key ses:SendEmail and ses:SendBulkEmail in its IAM policy.",
    retry_at: retryAt,
  }),
  noReceipts: (accepted: number): SendCondition => ({
    kind: "no_receipts",
    severity: "warn",
    since: null,
    message: `No delivery receipt has arrived for any of the ${accepted} recipients the provider took, 2 hours after the send went out. The provider's events may not be reaching this app, so its bounces and complaints suppress no one. Check the webhook and the app's error log.`,
    action: null,
    accepted,
  }),
  bounceSpike: (bounced: number, rate: number): SendCondition => ({
    kind: "bounce_spike",
    severity: "warn",
    since: null,
    message: `${bounced} recipients bounced (${Math.round(100 * rate)}%), at or above the 5% at which providers put a sender under review.`,
    action: null,
    bounced,
    rate,
  }),
};

// The server's missed tolerance (MISSED_THRESHOLD_MS in src/lib/time.ts).
const MISSED_MS = 5 * 60_000;

/**
 * A scripted server's sends over one change sequence, answering `GET /api/sends` and
 * `GET /api/sends/feed` the way the Worker does, so a page's own reads and the layer's feed see
 * one world. `put` is any client's (or the sweep's) write: it moves the send past every
 * cursor issued so far. The clock's own changes need no write: a scheduled send reads `due`
 * from its fire time and missed past the tolerance, and the feed reports each crossing
 * after a cursor's read time. A plain row implies its phase: `progressing` while sending,
 * `settling` while sent with receipts outstanding (`c_accepted`), `complete` once none are;
 * the halt comes from its `halt_*` fields, `account` reading as refused.
 */
export function sendServer(rows: SendSummary[] = []) {
  const sends = new Map<string, { row: SendSummary; extras: SendExtras }>();
  const removed = new Map<string, number>();
  let seq = 0;
  const put = (row: SendSummary, extras: SendExtras = {}) => {
    seq += 1;
    sends.set(row.id, { row: { ...row, rev: seq }, extras });
  };
  for (const row of rows) {
    put(row);
  }
  const cursor = () => encodeSendCursor({ seq, at: Date.now() });
  const derive = ({ row, extras }: { row: SendSummary; extras: SendExtras }, now: number) => {
    const clock = row.status === "scheduled" && now >= row.fire_at;
    const phase: SendPhase =
      extras.phase ??
      (row.status === "scheduled"
        ? clock
          ? "due"
          : "scheduled"
        : row.status === "sending"
          ? "progressing"
          : row.status === "sent"
            ? row.c_accepted > 0
              ? "settling"
              : "complete"
            : "canceled");
    const conditions: SendCondition[] = [];
    if (row.status === "scheduled" && now >= row.fire_at + MISSED_MS) {
      conditions.push({
        kind: "missed",
        severity: "action",
        since: row.fire_at + MISSED_MS,
        message: "The fire time passed and the send has not started.",
        action: null,
      });
    }
    if (row.status === "sending" && row.halt_reason === "account") {
      conditions.push({
        kind: "refused",
        severity: "action",
        since: row.halted_at,
        message: refusedMessage(row.halt_cause, row.halt_error),
        action: null,
        cause: row.halt_cause,
        error: row.halt_error ?? "",
        advice: refusalAdvice(row.halt_cause),
        retry_at: row.halt_retry_at,
      });
    }
    if (
      row.status === "scheduled" &&
      row.remade_at !== null &&
      (row.tested_at === null || row.tested_at < row.remade_at)
    ) {
      conditions.push({
        kind: "remade",
        severity: "info",
        since: row.remade_at,
        message:
          "The template or publication details changed this email’s look after your last test. Its content and send time are the same. Send a new test to check what will go out.",
        action: null,
        tested_at: row.tested_at,
      });
    }
    if (row.status === "scheduled" && row.tested_at === null && row.remade_at === null) {
      conditions.push({
        kind: "untested",
        severity: "info",
        since: row.scheduled_at,
        message:
          "No test of this email has been sent yet. Send yourself a test to check what will go out.",
        action: null,
      });
    }
    conditions.push(...(extras.conditions ?? []));
    // What the server would take now: the window's controls until the fire time, Resolve
    // while wedged.
    const actions: SendAction[] =
      extras.actions ??
      (row.status === "scheduled" && now < row.fire_at
        ? [
            { name: "cancel", method: "POST", path: `/api/sends/${row.id}/cancel` },
            { name: "reschedule", method: "POST", path: `/api/sends/${row.id}/reschedule` },
          ]
        : conditions.some((c) => c.kind === "wedged")
          ? [{ name: "resolve", method: "POST", path: `/api/sends/${row.id}/resolve` }]
          : []);
    return { phase, conditions, actions };
  };
  const view = (s: { row: SendSummary; extras: SendExtras }, now: number): SendView => {
    const { phase, conditions, actions } = derive(s, now);
    return sendView(s.row, {
      as_of: now,
      phase,
      conditions,
      actions,
      next_change_at: nextChange(s, now),
      email_only: s.extras.email_only ?? false,
      web_link: s.extras.web_link ?? "unlisted",
      dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: s.extras.eta_ms ?? null },
      ...(s.extras.archive === undefined
        ? {}
        : { links: { ...sendView(s.row).links, archive: s.extras.archive } }),
    });
  };
  // When a send can next change with no one acting, by the Worker's rule in outline: now
  // while due short of the tolerance or sending with nothing to wait for; a halted send at
  // its retry (less the sweep's half-tick of slack); a scheduled one at its fire time.
  const nextChange = (s: { row: SendSummary; extras: SendExtras }, now: number) => {
    const { row } = s;
    const { conditions } = derive(s, now);
    const kinds = new Set(conditions.map((c) => c.kind));
    if (row.status === "scheduled") {
      return row.fire_at > now ? row.fire_at : kinds.has("missed") ? null : now;
    }
    if (row.status !== "sending" || kinds.has("wedged")) {
      return null;
    }
    return row.halt_retry_at === null ? now : Math.max(now, row.halt_retry_at - 30_000);
  };
  const byFire = (dir: 1 | -1) => (a: { row: SendSummary }, b: { row: SendSummary }) =>
    dir * (a.row.fire_at - b.row.fire_at);
  const routes: FakeRoute[] = [
    {
      path: "/api/sends/feed",
      reply: (req): SendFeedResponse | Response => {
        const now = Date.now();
        const raw = req.url.searchParams.get("since");
        const since = raw === null ? null : decodeSendCursor(raw);
        if (raw !== null && !since) {
          return jsonResponse({ error: "bad_request", field: "since" }, 400);
        }
        const crossed = (t: number) => since !== null && since.at < t && t <= now;
        const all = [...sends.values()].sort(byFire(1));
        const reported = all.filter((s) => {
          if (since) {
            return (
              s.row.rev > since.seq ||
              (s.row.status === "scheduled" &&
                (crossed(s.row.fire_at) || crossed(s.row.fire_at + MISSED_MS)))
            );
          }
          const { phase } = derive(s, now);
          return phase === "due" || s.row.status === "sending" || phase === "settling";
        });
        const changes = all.map((s) => nextChange(s, now));
        const moving = changes.some((at) => at !== null && at <= now);
        const settling = all.some((s) => derive(s, now).phase === "settling");
        const ahead = changes.filter((at): at is number => at !== null && at > now);
        const wait = moving || settling ? 3000 : 60_000;
        return {
          now,
          sends: reported.map((s) => view(s, now)),
          removed: since
            ? [...removed].filter(([, rev]) => rev > since.seq).map(([id, rev]) => ({ id, rev }))
            : [],
          cursor: cursor(),
          more: false,
          conditions: all.flatMap((s) =>
            derive(s, now).conditions.map((c) => ({
              ...c,
              send_id: s.row.id,
              subject: s.row.subject,
            })),
          ),
          read_again_at: Math.min(now + wait, ahead.length ? Math.min(...ahead) + 1000 : Infinity),
        };
      },
    },
    {
      path: "/api/sends",
      reply: (req): SendListResponse => {
        const now = Date.now();
        const q = req.url.searchParams;
        const status = q.get("status");
        const rows = [...sends.values()]
          .filter((s) => !status || s.row.status === status)
          .sort(byFire(q.get("sort") === "fire" && q.get("dir") === "asc" ? 1 : -1))
          .map((s) => view(s, now));
        return {
          sends: rows,
          page: { total: rows.length, limit: 50, offset: 0, sort: "fire", dir: "desc" },
          cursor: cursor(),
        };
      },
    },
    {
      // One send, as `GET /api/sends/:id` answers it: its view, its outcomes from the
      // counters (the fake keeps no delivery rows; like the server's, a recipient not yet
      // handed off counts as in flight), and where the read stood.
      path: /^\/api\/sends\/(?!feed$)[^/]+$/,
      reply: (req): SendResponse | Response => {
        const id = req.url.pathname.split("/").pop() ?? "";
        const s = sends.get(id);
        if (!s) {
          return jsonResponse({ error: "not_found" }, 404);
        }
        const r = s.row;
        return {
          send: view(s, Date.now()),
          outcomes: {
            recipients: r.recipient_count,
            delivered: r.c_delivered,
            bounced: r.c_bounced,
            complained: r.c_complained,
            unsent: r.c_unsent,
            skipped: r.c_skipped,
            accepted: r.c_accepted,
            in_flight: r.c_pending + r.c_in_flight,
          },
          cursor: cursor(),
        };
      },
    },
  ];
  /**
   * Put `around` in front of one of these routes, by its path: it gets each request and the
   * route's own reply, to answer through it, beside it, or instead of it. The route keeps
   * its place, so a fake made from `routes` before the wrap answers through it too.
   */
  const wrap = (
    path: string,
    around: (req: FakeRequest, reply: (req: FakeRequest) => unknown) => unknown,
  ) => {
    const route = routes.find((r) => r.path === path);
    if (!route) {
      throw new Error(`no route ${path}`);
    }
    const reply = route.reply;
    route.reply = (req) => around(req, reply);
  };
  return {
    /** The feed, the list, and one send's read, for a spec's `fakeApi` beside its own. */
    routes,
    /** Write a send: a new one, or every field of one again (`extras` replaced, not merged). */
    put,
    /** Change some of a send's fields, as a write. */
    edit(id: string, over: Partial<SendSummary>, extras: SendExtras = {}) {
      const s = sends.get(id);
      if (!s) {
        throw new Error(`no send ${id}`);
      }
      put({ ...s.row, ...over }, extras);
    },
    /** Delete a send with its post: gone, and reported as removed after any earlier cursor. */
    remove(id: string) {
      seq += 1;
      sends.delete(id);
      removed.set(id, seq);
    },
    /** Where a read now stands, as a list route would hand it back (`GET /api/posts` carries one). */
    cursor,
    wrap,
    /** Refuse the next feed read as the server does after a reset or a restore: its cursor is ahead of the database. */
    aheadOnce() {
      let ahead = true;
      wrap("/api/sends/feed", (req, reply) => {
        if (!ahead) {
          return reply(req);
        }
        ahead = false;
        return jsonResponse({ error: "cursor_ahead", message: "reset" }, 409);
      });
    },
  };
}

/** The `GET /api/sends/feed` reads a spec's fake has seen. */
export const feedReads = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.url.pathname === "/api/sends/feed");

/** The `GET /api/sends` reads a spec's fake has seen. */
export const listReads = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.url.pathname === "/api/sends");
