import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceGroup } from "../../shared/reference";
import { $, $$, type FakeApi, fakeApi, jsonResponse, resetShell, settle } from "../test_support";
import { renderReference } from "./reference";

// Two tiers as the Worker groups them from its manifest; the webhook tier is absent, as it
// is when no route carries it.
const groups: ReferenceGroup[] = [
  {
    access: "admin",
    title: "Admin",
    blurb: "The editor & authoring API.",
    routes: [
      {
        method: "GET",
        path: "/posts",
        access: "admin",
        summary: "List posts.",
        description: "Offset-paged.",
        query: [{ name: "status", description: "draft, scheduled, or sent" }],
        example: { response: { posts: [] } },
      },
      {
        method: "POST",
        path: "/posts",
        access: "admin",
        summary: "Create <a post>.",
        example: { request: { subject: "Owls" }, response: { post: { id: "p1" } } },
      },
    ],
  },
  {
    access: "public",
    title: "Public",
    blurb: "No login.",
    routes: [{ method: "GET", path: "/subscribe", access: "public", summary: "Subscribe." }],
  },
];

/** Stands in for the browser's observer: records what is observed and lets a test fire an entry. */
class FakeObserver {
  static last: FakeObserver | null = null;
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  enter(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

describe("reference room", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/reference";
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => {
    fake?.restore();
    vi.unstubAllGlobals();
  });

  it("renders the tiers as sections and the nav with a count per tier, the first active", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await renderReference();
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("API");
    expect($$(".api-section").map((s) => s.id)).toEqual(["api-admin", "api-public"]);
    const nav = $$("#apiNav a");
    expect(nav.map((a) => a.dataset.sec)).toEqual(["admin", "public"]);
    expect(nav.map((a) => a.classList.contains("active"))).toEqual([true, false]);
    expect(nav.map((a) => $(".api-nav-count", a).textContent)).toEqual(["2", "1"]);
    expect($(".api-head p").textContent).toContain(`Base URL ${location.origin}.`);
    const routes = $$("#api-admin .api-route");
    expect(routes).toHaveLength(2);
    expect($(".api-method", routes[0]).className).toBe("api-method m-GET");
    expect($(".api-path", routes[0]).textContent).toBe("/posts");
    expect($(".api-tier", routes[0]).textContent).toBe("admin");
    expect($(".api-desc", routes[0]).textContent).toBe("Offset-paged.");
    expect($(".api-query td code", routes[0]).textContent).toBe("status");
    expect($(".api-summary", routes[1]).textContent).toBe("Create <a post>."); // text, not markup
    expect(document.querySelector(".api-summary a")).toBeNull();
    expect($$(".api-ex-label", routes[1]).map((l) => l.textContent)).toEqual([
      "Request",
      "Response",
    ]);
    expect($(".api-ex pre code", routes[1]).textContent).toBe(`{\n  "subject": "Owls"\n}`);
    expect($$(".api-ex", routes[0]).map((e) => $(".api-ex-label", e).textContent)).toEqual([
      "Query",
      "Response",
    ]); // no request example, no request block
    expect(fake.unhandled).toEqual([]);
  });

  it("jumps to a section from the nav without navigating", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await renderReference();
    await settle();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiNav a[data-sec='public']").click();
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.instances[0]).toBe($("#api-public"));
    expect(location.hash).toBe("#/reference");
    scroll.mockRestore();
  });

  it("highlights the tier in view as the reader scrolls, and drops the last room's observer on re-render", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await renderReference();
    await settle();
    const first = FakeObserver.last;
    expect(first?.observed).toEqual([$("#api-admin"), $("#api-public")]);
    first?.enter($("#api-public"));
    expect($$("#apiNav a").map((a) => a.classList.contains("active"))).toEqual([false, true]);
    await renderReference();
    await settle();
    expect(first?.disconnected).toBe(true);
    expect(FakeObserver.last).not.toBe(first);
  });

  it("shows the error with a retry that reloads", async () => {
    let failures = 1;
    fake = fakeApi([
      {
        path: "/api/reference",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { groups }),
      },
    ]);
    await renderReference();
    await settle();
    expect($("#apiContent .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await settle();
    expect($$(".api-section")).toHaveLength(2);
    expect(fake.calls).toHaveLength(2);
  });
});
