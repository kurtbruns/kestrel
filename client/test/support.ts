// Support for client specs: a scripted fetch that stands in for the HTTP API, the fixtures
// several specs share, and a few DOM helpers. The seam is fetch itself, so the real api()
// runs over the script (credential attached, 401 routed, errors shaped) and a view test
// exercises the same code the browser does, with only the network replaced. The scripted
// send server over it is `send_server.ts`. Imported by specs only; never part of the bundle.

import { vi } from "vitest";
import type { SendSummary } from "../../shared/sends";
import type { DeploymentView, SettingsResponse, SettingsView } from "../../shared/settings";
import { unmount } from "../lifecycle";
import { appState } from "../state";

/** One request the script saw. `url` is absolute against a placeholder origin. */
export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  /** A multipart body (an upload), as sent. */
  form: FormData | null;
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
      form: init?.body instanceof FormData ? init.body : null,
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

// The sidebar brand as the page ships it, before any spec's settings repaint it.
const BRAND = ["brandName", "brandTagline", "brandLogo"].map((id) => {
  const el = document.getElementById(id);
  return { id, html: el?.innerHTML ?? "", hidden: el?.hidden ?? false, cls: el?.className ?? "" };
});

/**
 * Tear down whatever is mounted and put the shell back as the page loads it, without
 * replacing the shell's root elements, which the shell module holds by reference: the
 * view and toast roots emptied, any dialog or stray frame a spec left on the body gone,
 * the sidebar brand as shipped, and no settings payload (a view that saves settings
 * writes it, and the brand and several views read it).
 */
export function resetShell(): void {
  unmount();
  for (const id of ["app", "toasts"]) {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = "";
    }
  }
  for (const el of document.querySelectorAll(".modal, .modal-backdrop, dialog, body > iframe")) {
    el.remove();
  }
  for (const b of BRAND) {
    const el = document.getElementById(b.id);
    if (el) {
      el.innerHTML = b.html;
      el.hidden = b.hidden;
      el.className = b.cls;
    }
  }
  appState.appConfig = null;
}

// The same DOM and lifecycle helpers the modules use, re-exported so a spec reads like the
// code it tests: a view is mounted the way the router mounts it.
export { mount, mounted, unmount } from "../lifecycle";
export { $, $$ } from "../ui/dom";

/** Hide or show the tab the way the browser does: `document.hidden`, then the event. */
export function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Drop what `setHidden` set, quietly (no event), so the document reads as it loaded. */
export function restoreHidden(): void {
  delete (document as { hidden?: boolean }).hidden;
}

/** A clipboard that records what is copied; `vi.unstubAllGlobals()` in afterEach puts it back. */
export function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

/**
 * What `GET /api/settings` answers, for a view that reads it: a publication on the dev fake
 * transport, with a template the server would take and nothing scheduled. `settings` and
 * `deployment` merge field by field over those defaults; the rest replaces.
 */
export function settingsResponse(
  over: {
    settings?: Partial<SettingsView>;
    deployment?: Partial<DeploymentView>;
  } & Partial<Omit<SettingsResponse, "settings" | "deployment">> = {},
): SettingsResponse {
  const { settings, deployment, ...rest } = over;
  return {
    settings: {
      testRecipients: [],
      publication: { name: "Birds Weekly", tagline: "", address: "", logoUrl: "" },
      emailTemplate: '<div>{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">out</a></div>',
      confirmationEmail: { subject: "", body: "", buttonLabel: "", reassurance: "" },
      confirmationEmailDefault: {
        subject: "Confirm your subscription",
        body: "Click below to confirm.",
        buttonLabel: "Confirm",
        reassurance: "If this wasn't you, ignore this email.",
      },
      notifications: { to: "" },
      ...settings,
    },
    deployment: {
      provider: "fake",
      fromAddress: "Birds <hello@birds.example>",
      sendingDomain: "birds.example",
      appOrigin: "https://app.birds.example",
      archiveOrigin: "https://app.birds.example",
      archiveBasePath: "/archive",
      mediaPublicBase: "https://app.birds.example/media",
      awsRegion: "",
      accessConfigured: false,
      authMode: "dev",
      notifyChannel: "fake",
      notifyFrom: "Birds <hello@birds.example>",
      minLeadMs: 5 * 60 * 1000,
      simulation: null,
      notConnectedPreview: false,
      freePlanLimits: false,
      build: {
        version: "",
        sha: "dev",
        tag: "",
        buildTime: "",
        repoUrl: "",
        commitUrl: "",
        tagUrl: "",
      },
      ...deployment,
    },
    notificationStatus: { lastSent: null, lastFailure: null },
    inUse: { sends: [], retry_after: null, identityFields: ["name"] },
    ...rest,
  };
}

/**
 * A stored send row (`SendSummary`), for a spec's scripted sends: scheduled an hour from now,
 * to ten recipients, nothing handed off or counted yet. A spec sets in `over` whatever it
 * asserts on, so the value reads where the assertion is.
 */
export function sendSummary(over: Partial<SendSummary> = {}): SendSummary {
  return {
    id: "x1",
    post_id: "p1",
    status: "scheduled",
    fire_at: Date.now() + 3_600_000,
    subject: "Owls",
    recipient_count: 10,
    locked_until: null,
    scheduled_at: Date.now(),
    started_at: null,
    completed_at: null,
    audience_resolved_at: null,
    remade_at: null,
    tested_at: null,
    halt_reason: null,
    halt_cause: null,
    halt_error: null,
    halted_at: null,
    halt_retries: 0,
    halt_retry_at: null,
    c_pending: 0,
    c_in_flight: 0,
    c_accepted: 0,
    c_delivered: 0,
    c_bounced: 0,
    c_complained: 0,
    c_skipped: 0,
    c_unsent: 0,
    rev: 1,
    ...over,
  };
}

/** A file the page handed the reader: its name and contents. */
export interface SavedFile {
  name: string;
  blob: Blob;
}

/**
 * Record each file the page saves (an object URL clicked through an anchor, `ui/download`)
 * instead of letting that click run. Each object URL is unique and maps to its own blob, so
 * a click is matched to the file it names; a click on any other anchor runs as it would.
 * `vi.restoreAllMocks()` in afterEach puts it back.
 */
export function captureDownloads(): SavedFile[] {
  const saved: SavedFile[] = [];
  const blobs = new Map<string, Blob>();
  let seq = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
    const url = `blob:http://kestrel.test/download-${++seq}`;
    blobs.set(url, b as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    blobs.delete(url);
  });
  const click = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) {
      saved.push({ name: this.download, blob });
    } else {
      click.call(this);
    }
  });
  return saved;
}

/** Set a field's value the way typing would be seen by the app: value, then an input event. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
