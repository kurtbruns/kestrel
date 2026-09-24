// Support for client specs: a scripted fetch that stands in for the HTTP API, and a few
// DOM helpers. The seam is fetch itself, so the real api() runs over the script (credential
// attached, 401 routed, errors shaped) and a view test exercises the same code the browser
// does, with only the network replaced. Imported by specs only; never part of the bundle.

import { decodeSendCursor, encodeSendCursor } from "../../shared/cursor";
import type {
  LiveSend,
  SendAttention,
  SendFeedResponse,
  SendListItem,
  SendListResponse,
  SendPhase,
  SendSummary,
} from "../../shared/sends";
import { unmount } from "../lifecycle";

/** One request the script saw. `url` is absolute against a placeholder origin. */
export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

/** A request handed to a route's reply, with its JSON body parsed on demand. */
export interface FakeRequest extends FakeCall {
  json(): unknown;
}

/**
 * A scripted endpoint: method (GET by default) + path (exact, or a pattern) → what it
 * answers, as a value (sent as JSON), a Response, or a promise of either (to hold a reply
 * open while the spec does something mid-flight).
 */
export interface FakeRoute {
  method?: string;
  path: string | RegExp;
  reply: (req: FakeRequest) => unknown;
}

export interface FakeApi {
  /** Every request, in order, whether or not a route matched. */
  calls: FakeRequest[];
  /** Requests no route matched; they were answered 404. Assert this is empty. */
  unhandled: FakeRequest[];
  /** Put the real fetch back. */
  restore(): void;
}

const ORIGIN = "http://kestrel.test";

/** A JSON response with a status; what a route reply is wrapped in unless it returns a Response. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Replace the global fetch with a script for the duration of a test. Routes are tried in
 * order; the first whose method and path match answers. A request carrying a signal is cut
 * off the way the real fetch cuts it off: an AbortError, at once if already aborted, or the
 * moment it aborts while the reply is pending. Call `restore()` in afterEach.
 */
export function fakeApi(routes: FakeRoute[]): FakeApi {
  const previous = globalThis.fetch;
  const calls: FakeRequest[] = [];
  const unhandled: FakeRequest[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, ORIGIN);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const call: FakeRequest = {
      method,
      url,
      headers: new Headers(init?.headers),
      body,
      json: () => (body ? JSON.parse(body) : null),
    };
    calls.push(call);
    const route = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    if (!route) {
      unhandled.push(call);
      return jsonResponse({ error: `no fake route for ${method} ${url.pathname}` }, 404);
    }
    const signal = init?.signal ?? null;
    const aborted = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) {
      throw aborted();
    }
    const replied = Promise.resolve(route.reply(call));
    const out = signal
      ? await Promise.race([
          replied,
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(aborted()), { once: true }),
          ),
        ])
      : await replied;
    return out instanceof Response ? out : jsonResponse(out);
  };
  return {
    calls,
    unhandled,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

/** Let queued promises and zero-delay timers run. Needs real timers; with fake ones, advance them instead. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Tear down whatever is mounted and empty what it left in the shell, without replacing the
 * shell's root elements, which the shell module holds by reference.
 */
export function resetShell(): void {
  unmount();
  for (const id of ["app", "toasts"]) {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = "";
    }
  }
  for (const modal of document.querySelectorAll(".modal, .modal-backdrop, dialog")) {
    modal.remove();
  }
}

// The same DOM and lifecycle helpers the modules use, re-exported so a spec reads like the
// code it tests: a view is mounted the way the router mounts it.
export { mount, mounted, unmount } from "../lifecycle";
export { $, $$ } from "../ui/dom";

/** Set a field's value the way typing would be seen by the app: value, then an input event. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What a scripted send carries beyond its row: what the server would derive for it. */
export interface SendExtras {
  /** The phase, when not the one a spec's plain row implies (see `sendServer`). */
  phase?: SendPhase;
  attention?: Partial<SendAttention>;
  eta_ms?: number | null;
}

// The server's missed tolerance (MISSED_THRESHOLD_MS in src/lib/time.ts).
const MISSED_MS = 5 * 60_000;

/**
 * A scripted server's sends over one change sequence, answering `GET /sends` and
 * `GET /sends/feed` the way the Worker does, so a page's own reads and the layer's feed see
 * one world. `put` is any client's (or the sweep's) write: it moves the send past every
 * cursor issued so far. The clock's own changes need no write: a scheduled send reads `due`
 * from its fire time and missed past the tolerance, and the feed reports each crossing
 * after a cursor's read time. A plain row implies its phase: `progressing` while sending,
 * `settling` while sent with receipts outstanding (`c_accepted`), `complete` once none are;
 * the halt comes from its `halt_*` fields, `account` reading as refused.
 */
export function sendServer(rows: SendSummary[] = []) {
  const sends = new Map<string, { row: SendSummary; extras: SendExtras }>();
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
    const attention: SendAttention = {
      wedged: false,
      wedged_count: 0,
      stuck: false,
      missed: row.status === "scheduled" && now >= row.fire_at + MISSED_MS,
      refused: row.status === "sending" && row.halt_reason === "account",
      ...extras.attention,
    };
    return { phase, attention };
  };
  const item = (s: { row: SendSummary; extras: SendExtras }, now: number): SendListItem => {
    const { phase, attention } = derive(s, now);
    return { ...s.row, phase, attention, stuck: attention.stuck };
  };
  const live = (s: { row: SendSummary; extras: SendExtras }, now: number): LiveSend => {
    const { row } = s;
    const { phase, attention } = derive(s, now);
    return {
      id: row.id,
      post_id: row.post_id,
      subject: row.subject,
      fire_at: row.fire_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      state: row.status,
      phase,
      total: row.recipient_count,
      counts: {
        pending: row.c_pending,
        in_flight: row.c_in_flight,
        accepted: row.c_accepted,
        delivered: row.c_delivered,
        bounced: row.c_bounced,
        complained: row.c_complained,
        skipped: row.c_skipped,
        unsent: row.c_unsent,
      },
      dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: s.extras.eta_ms ?? null },
      delivery: {
        confirmed: row.c_delivered + row.c_bounced + row.c_complained,
        percent_of_accepted: 0,
      },
      provider: {
        name: "fake",
        halt: row.halt_reason
          ? {
              reason: row.halt_reason,
              cause: row.halt_cause,
              error: row.halt_error ?? "",
              since: row.halted_at ?? 0,
              retry_at: row.halt_retry_at ?? 0,
            }
          : null,
      },
      attention,
    };
  };
  const byFire = (dir: 1 | -1) => (a: { row: SendSummary }, b: { row: SendSummary }) =>
    dir * (a.row.fire_at - b.row.fire_at);
  const routes: FakeRoute[] = [
    {
      path: "/sends/feed",
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
        const phases = all.map((s) => derive(s, now).phase);
        const active = all.some((s, i) => phases[i] === "due" || s.row.status === "sending");
        const settling = phases.includes("settling");
        const next = all.find((s) => s.row.status === "scheduled" && s.row.fire_at > now);
        const wait = active || settling ? 3000 : 60_000;
        return {
          now,
          sends: reported.map((s) => live(s, now)),
          cursor: cursor(),
          read_again_at: Math.min(now + wait, next ? next.row.fire_at + 1000 : Infinity),
        };
      },
    },
    {
      path: "/sends",
      reply: (req): SendListResponse => {
        const now = Date.now();
        const q = req.url.searchParams;
        const status = q.get("status");
        const rows = [...sends.values()]
          .filter((s) => !status || s.row.status === status)
          .sort(byFire(q.get("sort") === "fire" && q.get("dir") === "asc" ? 1 : -1))
          .map((s) => item(s, now));
        return {
          sends: rows,
          page: { total: rows.length, limit: 50, offset: 0, sort: "fire", dir: "desc" },
          cursor: cursor(),
        };
      },
    },
  ];
  return {
    /** The two routes, for a spec's `fakeApi` beside its own. */
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
  };
}

/** The `GET /sends/feed` reads a spec's fake has seen. */
export const feedReads = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.url.pathname === "/sends/feed");

/** The `GET /sends` reads a spec's fake has seen. */
export const listReads = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.url.pathname === "/sends");
