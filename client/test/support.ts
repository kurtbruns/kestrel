// Support for client specs: a scripted fetch that stands in for the HTTP API, and a few
// DOM helpers. The seam is fetch itself, so the real api() runs over the script (credential
// attached, 401 routed, errors shaped) and a view test exercises the same code the browser
// does, with only the network replaced. Imported by specs only; never part of the bundle.

import type {
  LiveSend,
  LiveSendsResponse,
  SendHalt,
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

/**
 * A send as `GET /sends/live` reports it, built from a list row: its fields and counters in
 * the live shape, with the phase, flags, and halt the server would derive, given here since
 * a spec scripts the server.
 */
export function liveSend(
  row: SendSummary,
  phase: SendPhase,
  over: {
    attention?: Partial<LiveSend["attention"]>;
    halt?: SendHalt | null;
    eta_ms?: number | null;
  } = {},
): LiveSend {
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
    dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: over.eta_ms ?? null },
    delivery: {
      confirmed: row.c_delivered + row.c_bounced + row.c_complained,
      percent_of_accepted: 0,
    },
    provider: { name: "fake", halt: over.halt ?? null },
    attention: {
      wedged: false,
      wedged_count: 0,
      stuck: false,
      missed: false,
      refused: false,
      ...over.attention,
    },
  };
}

/**
 * `GET /sends/live` over a scripted server: `known()` is every send it would report, and it
 * answers the way the Worker does, the live ones (due, sending, settling) under `sends`, the
 * ones named in `ids` that aren't under `named`, and `next()` as the next fire time.
 */
export function liveRoute(
  known: () => LiveSend[],
  next: () => number | null = () => null,
): FakeRoute {
  const isLive = (s: LiveSend) =>
    (s.state === "scheduled" && s.phase === "due") ||
    s.state === "sending" ||
    (s.state === "sent" && s.phase === "settling");
  return {
    path: "/sends/live",
    reply: (req): LiveSendsResponse => {
      const ids = (req.url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const all = known();
      return {
        now: Date.now(),
        sends: all.filter(isLive),
        named: all.filter((s) => !isLive(s) && ids.includes(s.id)),
        next_fire_at: next(),
      };
    },
  };
}

/** The `GET /sends/live` reads a spec's fake has seen. */
export const liveReads = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.url.pathname === "/sends/live");
