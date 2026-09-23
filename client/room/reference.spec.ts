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

describe("reference room", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/reference";
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
    expect($("#api-admin-posts .api-res-head").textContent).toBe("Posts");
    // The rail lists a tier's resources only when it has more than one.
    const nav = $$("#apiNav a");
    expect(nav.map((a) => a.dataset.sec)).toEqual([
      "admin",
      "admin-posts",
      "admin-sends",
      "public",
    ]);
    expect(nav.map((a) => a.textContent)).toEqual(["Admin", "Posts", "Sends", "Public"]);
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
    expect($$(".api-ex-label", rows[1]).map((l) => l.textContent)).toEqual([
      "Request",
      "Response",
      "curl",
    ]);
    expect($$(".api-ex", rows[0]).map((e) => $(".api-ex-label", e).textContent)).toEqual([
      "Query",
      "Response",
      "curl",
    ]); // no request example, no request block
    // An example is pretty-printed JSON, highlighted: the key and the string are marked.
    const request = $(".api-ex pre code", rows[1]);
    expect(request.textContent).toBe(`{\n  "subject": "Owls"\n}`);
    expect($(".cx-prop", request).textContent).toBe(`"subject"`);
    expect($(".cx-str", request).textContent).toBe(`"Owls"`);
    expect(fake.unhandled).toEqual([]);
  });

  it("gives each route a curl command on this instance, and none to a webhook", async () => {
    const withWebhook: ReferenceGroup[] = [
      ...groups,
      {
        access: "webhook",
        title: "Webhooks",
        blurb: "Provider callbacks.",
        resources: [{ key: "delivery", title: "Delivery events" }],
        routes: [
          {
            method: "POST",
            path: "/webhooks/ses",
            access: "webhook",
            resource: "delivery",
            summary: "SES events.",
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups: withWebhook }) }]);
    await mount(renderReference);
    await settle();
    const curlOf = (row: Element) =>
      $$(".api-ex", row).find((e) => $(".api-ex-label", e).textContent === "curl");
    const create = $$("#api-admin-posts details.api-route")[1]!;
    // No session in this harness, so the dev token stands in for Access.
    expect(curlOf(create)?.querySelector("code")?.textContent).toBe(
      [
        `curl -X POST "${location.origin}/posts"`,
        '  -H "Authorization: Bearer $TOKEN"',
        '  -H "Content-Type: application/json"',
        `  -d '{"subject":"Owls"}'`,
      ].join(" \\\n"),
    );
    expect(curlOf($("#api-webhook-delivery details.api-route"))).toBeUndefined();
  });

  it("copies a code block's plain text, not its highlighted markup, and shows a check for a moment", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    vi.useFakeTimers();
    try {
      const create = $$("#api-admin-posts details.api-route")[1]!;
      const copy = $<HTMLButtonElement>(".api-ex button.api-copy", create);
      const glyph = () => copy.querySelector("svg")?.outerHTML;
      const resting = glyph();
      expect(copy.textContent?.trim()).toBe("Copy");
      expect(copy.getAttribute("aria-label")).toBe("Copy Request");
      copy.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledWith(`{\n  "subject": "Owls"\n}`);
      expect(copy.getAttribute("aria-label")).toBe("Copied");
      expect(copy.classList.contains("copied")).toBe(true);
      expect(glyph()).not.toBe(resting);
      expect(copy.textContent?.trim()).toBe("Copy"); // the word stays; only the glyph changes
      // A second copy mid-moment restarts it rather than being cut short by the first.
      await vi.advanceTimersByTimeAsync(1000);
      copy.click();
      await vi.advanceTimersByTimeAsync(1000);
      expect(copy.getAttribute("aria-label")).toBe("Copied");
      await vi.advanceTimersByTimeAsync(600);
      expect(copy.getAttribute("aria-label")).toBe("Copy Request");
      expect(copy.classList.contains("copied")).toBe(false);
      expect(glyph()).toBe(resting);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a query parameter the route can't do without", async () => {
    const withToken: ReferenceGroup[] = [
      {
        ...groups[1]!,
        routes: [
          {
            method: "GET",
            path: "/confirm",
            access: "public",
            resource: "subscriptions",
            summary: "Confirm.",
            query: [{ name: "token", description: "The link's token.", required: true }],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups: withToken }) }]);
    await mount(renderReference);
    await settle();
    expect($(".api-query td").textContent).toBe("token required");
    expect($$("code", $$(".api-ex").at(-1)!).at(-1)?.textContent).toBe(
      `curl "${location.origin}/confirm?token=:token"`,
    );
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

  it("lights the rail for the last tier or resource heading scrolled under the bar, and stops following once the room is left", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => ({ groups }) }]);
    await mount(renderReference);
    await settle();
    // No layout here, so place the headings by hand: `scrolled` names those above the line.
    let scrolled: string[] = [];
    for (const el of $$(".api-section, .api-res")) {
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(
        () => ({ top: scrolled.includes(el.id) ? 0 : 1000 }) as DOMRect,
      );
    }
    const nav = $("#apiNav");
    const active = () => $$("a.active", nav).map((a) => a.dataset.sec);
    const scrollTo = (ids: string[]) => {
      scrolled = ids;
      window.dispatchEvent(new Event("scroll"));
    };
    scrollTo([]);
    expect(active()).toEqual(["admin"]); // at the top, the first tier
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["admin-sends"]);
    // A jump straight to a tier lights the tier, before any of its resources pass the line;
    // a resource the rail doesn't list (a one-resource tier) keeps its tier lit.
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends", "api-public"]);
    expect(active()).toEqual(["public"]);
    scrollTo([
      "api-admin",
      "api-admin-posts",
      "api-admin-sends",
      "api-public",
      "api-public-subscriptions",
    ]);
    expect(active()).toEqual(["public"]);
    // At the bottom of a scrolled page the last heading wins, even one short of the line.
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(500);
    const height = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(window.innerHeight + 500);
    scrollTo(["api-admin"]);
    expect(active()).toEqual(["public"]);
    scrollY.mockRestore();
    height.mockRestore();
    // A filtered-out heading is skipped, and with nothing left the rail lights nothing.
    $("#api-admin-sends").hidden = true;
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["admin-posts"]);
    for (const sec of $$(".api-section")) {
      sec.hidden = true;
    }
    scrollTo([]);
    expect(active()).toEqual([]);
    for (const el of $$(".api-section, .api-res")) {
      el.hidden = false;
    }
    // On a phone the rail hides its resource links, so the tier chip takes the highlight.
    const phone = document.createElement("style");
    phone.textContent = ".api-nav-res { display: none; }";
    document.head.append(phone);
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["admin"]);
    phone.remove();
    scrollTo(["api-admin", "api-admin-posts"]);
    expect(active()).toEqual(["admin-posts"]);
    unmount();
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["admin-posts"]); // the detached rail no longer moves
  });

  it("filters rows by method, path, or summary, with the headings and rail links that still hold one", async () => {
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

    expect(filter.placeholder).toBe("Filter routes by method, path, or summary");
    expect($("#apiFilterClear").hidden).toBe(true);
    type("post create");
    expect($("#apiFilterClear").hidden).toBe(false);
    expect(shown()).toEqual(["POST /posts"]);
    expect($("#api-admin-sends").hidden).toBe(true);
    expect($("#api-public").hidden).toBe(true);
    expect($$("#apiNav a").map((a) => (a.hidden ? "hidden" : a.dataset.sec))).toEqual([
      "admin",
      "admin-posts",
      "hidden",
      "hidden",
    ]);
    expect($("#apiEmpty").hidden).toBe(true);
    // The last tier still shown keeps the last tier's room to scroll up under the bar.
    expect($$(".api-section.api-last").map((sec) => sec.id)).toEqual(["api-admin"]);

    type("nothing-matches");
    expect(shown()).toEqual([]);
    expect($("#apiEmpty").hidden).toBe(false);

    // The clear control empties it and hands focus back to the field.
    $("#apiFilterClear").click();
    expect(filter.value).toBe("");
    expect(shown()).toHaveLength(5);
    expect($("#apiFilterClear").hidden).toBe(true);
    expect(document.activeElement).toBe(filter);

    // Escape in the filter clears it too.
    type("cancel");
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
