// Support for client specs: a scripted fetch that stands in for the HTTP API, and a few
// DOM helpers. The seam is fetch itself, so the real api() runs over the script (credential
// attached, 401 routed, errors shaped) and a view test exercises the same code the browser
// does, with only the network replaced. Imported by specs only; never part of the bundle.

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
 * order; the first whose method and path match answers. Call `restore()` in afterEach.
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
    const out = await route.reply(call);
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

/** Empty what a view may have left in the shell without replacing its root elements, which the shell module holds by reference. */
export function resetShell(): void {
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

// The same DOM helpers the modules use, re-exported so a spec reads like the code it tests.
export { $, $$ } from "../ui/dom";

/** Set a field's value the way typing would be seen by the app: value, then an input event. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
