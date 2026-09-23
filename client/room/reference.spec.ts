import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceGroup } from "../../shared/reference";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  unmount,
} from "../test/support";
import { renderReference } from "./reference";

// Two tiers as the Worker groups them from its manifest: admin with two resources, public
// with one. The webhook tier is absent, as it is when no route carries it.
const groups: ReferenceGroup[] = [
  {
    access: "admin",
    title: "Admin",
    blurb: "The editor & authoring API.",
    resources: [
      { key: "posts", title: "Posts" },
      { key: "sends", title: "Sends" },
    ],
    routes: [
      {
        method: "GET",
        path: "/posts",
        access: "admin",
        resource: "posts",
        summary: "List posts.",
        description: "Offset-paged.",
        query: [{ name: "status", description: "draft, scheduled, or sent" }],
        example: { response: { posts: [] } },
      },
      {
        method: "POST",
        path: "/posts",
        access: "admin",
        resource: "posts",
        summary: "Create <a post>.",
        example: { request: { subject: "Owls" }, response: { post: { id: "p1" } } },
      },
      {
        method: "GET",
        path: "/posts/:id",
        access: "admin",
        resource: "posts",
        summary: "One post.",
      },
      {
        method: "POST",
        path: "/sends/:id/cancel",
        access: "admin",
        resource: "sends",
        summary: "Cancel a send.",
      },
    ],
  },
  {
    access: "public",
    title: "Public",
    blurb: "No login.",
    resources: [{ key: "subscriptions", title: "Subscriptions" }],
    routes: [
      {
        method: "GET",
        path: "/subscribe",
        access: "public",
        resource: "subscriptions",
        summary: "Subscribe.",
      },
    ],
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

  it("renders each tier's resources as groups of collapsed rows, and a rail of tiers and resources", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("API");
    expect($$(".api-section").map((s) => s.id)).toEqual(["api-admin", "api-public"]);
    expect($$(".api-res").map((r) => r.id)).toEqual([
      "api-admin-posts",
      "api-admin-sends",
      "api-public-subscriptions",
    ]);
    expect($("#api-admin-posts .api-res-head h3").textContent).toBe("Posts");
    expect($("#api-admin-posts .api-res-head [data-count]").textContent).toBe("3");
    // The rail lists a tier's resources only when it has more than one.
    const nav = $$("#apiNav a");
    expect(nav.map((a) => a.dataset.sec)).toEqual([
      "admin",
      "admin-posts",
      "admin-sends",
      "public",
    ]);
    expect(nav.map((a) => $(".api-nav-count", a).textContent)).toEqual(["4", "3", "1", "1"]);
    expect(nav.map((a) => a.classList.contains("active"))).toEqual([true, false, false, false]);
    expect($(".api-head p").textContent).toContain(`Base URL ${location.origin}.`);
    // Every row starts collapsed: badge, path, and summary line in the summary.
    const rows = $$<HTMLDetailsElement>("#api-admin-posts details.api-route");
    expect(rows).toHaveLength(3);
    expect(rows.every((d) => !d.open)).toBe(true);
    expect($(".api-method", rows[0]).className).toBe("api-method m-GET");
    expect($(".api-path", rows[0]).textContent).toBe("/posts");
    expect($(".api-route-line", rows[0]).textContent).toBe("List posts.");
    expect(document.querySelector(".api-tier")).toBeNull(); // the tier heads the section, not each row
    // A path parameter is marked; the rest of the path is text.
    expect($(".api-path", rows[2]).textContent).toBe("/posts/:id");
    expect($$(".api-param", rows[2]).map((p) => p.textContent)).toEqual([":id"]);
    // The detail: summary, description, query, then the examples that exist.
    expect($(".api-desc", rows[0]).textContent).toBe("Offset-paged.");
    expect($(".api-query td code", rows[0]).textContent).toBe("status");
    expect($(".api-summary", rows[1]).textContent).toBe("Create <a post>."); // text, not markup
    expect(document.querySelector(".api-summary a, .api-route-line a")).toBeNull();
    expect($$(".api-ex-label", rows[1]).map((l) => l.textContent)).toEqual(["Request", "Response"]);
    expect($(".api-ex pre code", rows[1]).textContent).toBe(`{\n  "subject": "Owls"\n}`);
    expect($$(".api-ex", rows[0]).map((e) => $(".api-ex-label", e).textContent)).toEqual([
      "Query",
      "Response",
    ]); // no request example, no request block
    expect(fake.unhandled).toEqual([]);
  });

  it("jumps to a tier or a resource from the rail without navigating", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiNav a[data-sec='public']").click();
    $("#apiNav a[data-sec='admin-sends']").click();
    expect(scroll.mock.instances).toEqual([$("#api-public"), $("#api-admin-sends")]);
    expect(location.hash).toBe("#/reference");
    scroll.mockRestore();
  });

  it("highlights the resource in view, or its tier when the rail lists the tier alone, and drops the last room's observer on re-render", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    const first = FakeObserver.last;
    expect(first?.observed).toEqual($$(".api-res"));
    const active = () => $$("#apiNav a.active").map((a) => a.dataset.sec);
    first?.enter($("#api-admin-sends"));
    expect(active()).toEqual(["admin-sends"]);
    first?.enter($("#api-public-subscriptions"));
    expect(active()).toEqual(["public"]);
    await mount(renderReference);
    await settle();
    expect(first?.disconnected).toBe(true);
    expect(FakeObserver.last).not.toBe(first);
  });

  it("filters rows by method, path, or summary, keeping every count to what is shown", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    const filter = $<HTMLInputElement>("#apiFilter");
    const type = (value: string) => {
      filter.value = value;
      filter.dispatchEvent(new Event("input"));
    };
    const shown = () =>
      $$("li[data-hay]")
        .filter((li) => !li.hidden)
        .map((li) => `${$(".api-method", li).textContent} ${$(".api-path", li).textContent}`);

    type("post create");
    expect(shown()).toEqual(["POST /posts"]);
    expect($("#api-admin-posts [data-count]").textContent).toBe("1");
    expect($("#api-admin-sends").hidden).toBe(true);
    expect($("#api-public").hidden).toBe(true);
    expect(
      $$("#apiNav a").map((a) => (a.hidden ? "-" : $(".api-nav-count", a).textContent)),
    ).toEqual(["1", "1", "-", "-"]);
    expect($("#apiEmpty").hidden).toBe(true);

    type("nothing-matches");
    expect(shown()).toEqual([]);
    expect($("#apiEmpty").hidden).toBe(false);

    // Escape in the filter clears it and brings everything back.
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(filter.value).toBe("");
    expect(shown()).toHaveLength(5);
    expect($("#apiEmpty").hidden).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("focuses the filter on / unless the reader is typing elsewhere, and stops listening once the room is left", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    const filter = $<HTMLInputElement>("#apiFilter");
    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(slash);
    expect(document.activeElement).toBe(filter);
    expect(slash.defaultPrevented).toBe(true);
    // Typed into the filter itself, "/" is a character, not the shortcut.
    const inFilter = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    filter.dispatchEvent(inFilter);
    expect(inFilter.defaultPrevented).toBe(false);
    filter.blur();
    unmount();
    const after = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("shows the error with a retry that reloads", async () => {
    let failures = 1;
    fake = fakeApi([
      {
        path: "/api/reference",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { groups }),
      },
    ]);
    await mount(renderReference);
    await settle();
    expect($("#apiContent .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await settle();
    expect($$(".api-section")).toHaveLength(2);
    expect($$("details.api-route")).toHaveLength(5);
    expect(fake.calls).toHaveLength(2);
  });
});
