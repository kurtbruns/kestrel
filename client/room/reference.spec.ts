import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceGroup, ReferenceResponse } from "../../shared/reference";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  stubClipboard,
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
        path: "/api/posts",
        access: "admin",
        resource: "posts",
        title: "List posts",
        summary: "List posts.",
        description: "Offset-paged.",
        query: [{ name: "status", description: "draft, scheduled, or sent" }],
        example: { response: { posts: [] } },
      },
      {
        method: "POST",
        path: "/api/posts",
        access: "admin",
        resource: "posts",
        title: "Create <a post>",
        summary: "Create <a post>.",
        example: { request: { subject: "Owls" }, response: { post: { id: "p1" } } },
      },
      {
        method: "GET",
        path: "/api/posts/:id",
        access: "admin",
        resource: "posts",
        title: "Retrieve a post",
        summary: "One post.",
      },
      {
        method: "POST",
        path: "/api/sends/:id/cancel",
        access: "admin",
        resource: "sends",
        title: "Cancel a send",
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
        title: "Subscribe",
        summary: "Subscribe.",
      },
    ],
  },
];

// What every route shares, as the Worker describes it once: one concept, one refusal group,
// and one object, so a route's links into them have somewhere to land.
const shared: Omit<ReferenceResponse, "groups"> = {
  concepts: [
    {
      key: "errors",
      title: "Errors",
      text: "A refusal names its <field>.\n\nEvery code, by what to do next:",
    },
  ],
  refusals: [
    {
      move: "Nothing: the act no longer applies",
      codes: [{ code: "window_closed", status: 409, meaning: "The fire time has passed." }],
    },
  ],
  objects: [
    {
      key: "send",
      resource: "sends",
      title: "The send view",
      description: "One send.",
      fields: [
        {
          name: "status",
          type: "string",
          description: "Its state.",
          values: [{ value: "scheduled", description: "Cancelable." }],
        },
      ],
      example: { id: "s1" },
    },
  ],
};
const reference = (g: ReferenceGroup[]): ReferenceResponse => ({ ...shared, groups: g });

describe("reference room", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/reference";
  });
  afterEach(() => {
    fake?.restore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders each tier's resources as groups of collapsed rows, and a rail of tiers and resources", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("API");
    // The topics every route shares come first, then the tiers.
    expect($$(".api-section").map((s) => s.id)).toEqual([
      "api-overview",
      "api-admin",
      "api-public",
    ]);
    expect($$(".api-res").map((r) => r.id)).toEqual([
      "api-overview-errors",
      "api-admin-posts",
      "api-admin-sends",
      "api-public-subscriptions",
    ]);
    expect($("#api-admin-posts .api-res-head").textContent).toBe("Posts");
    // The rail lists a tier's resources only when it has more than one.
    const nav = $$("#apiNav a");
    expect(nav.map((a) => a.dataset.sec)).toEqual([
      "overview",
      "overview-errors",
      "admin",
      "admin-posts",
      "admin-sends",
      "public",
    ]);
    expect(nav.map((a) => a.textContent)).toEqual([
      "Getting started",
      "Errors",
      "Admin",
      "Posts",
      "Sends",
      "Public",
    ]);
    expect($(".api-head p").textContent).toContain(`Base URL ${location.origin}.`);
    // Every row starts collapsed: badge, then the route's name over its path.
    const rows = $$<HTMLDetailsElement>("#api-admin-posts details.api-route");
    expect(rows).toHaveLength(3);
    expect(rows.every((d) => !d.open)).toBe(true);
    expect($(".api-method", rows[0]).className).toBe("api-method m-GET");
    expect($(".api-path", rows[0]).textContent).toBe("/api/posts");
    expect($(".api-route-title", rows[0]).textContent).toBe("List posts");
    expect($(".api-route-sum", rows[0]).textContent).not.toContain("List posts.");
    expect(document.querySelector(".api-tier")).toBeNull(); // the tier heads the section, not each row
    // A path parameter is marked; the rest of the path is text.
    expect($(".api-path", rows[2]).textContent).toBe("/api/posts/:id");
    expect($$(".api-param", rows[2]).map((p) => p.textContent)).toEqual([":id"]);
    // The detail: summary, description, query, then the examples that exist.
    expect($(".api-desc", rows[0]).textContent).toBe("Offset-paged.");
    expect($(".api-query td code", rows[0]).textContent).toBe("status");
    expect($(".api-summary", rows[1]).textContent).toBe("Create <a post>."); // text, not markup
    expect($(".api-route-title", rows[1]).textContent).toBe("Create <a post>");
    expect(document.querySelector(".api-summary a, .api-route-title a")).toBeNull();
    expect($$(".block-label", rows[1]).map((l) => l.textContent)).toEqual([
      "Request",
      "Response",
      "curl",
    ]);
    expect($$(".block", rows[0]).map((e) => $(".block-label", e).textContent)).toEqual([
      "Query",
      "Response",
      "curl",
    ]); // no request example, no request block
    // An example is pretty-printed JSON, highlighted: the key and the string are marked.
    const request = $(".block pre code", rows[1]);
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
            title: "SES events",
            summary: "SES events.",
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withWebhook) }]);
    await mount(renderReference);
    await settle();
    const curlOf = (row: Element) =>
      $$(".block", row).find((e) => $(".block-label", e).textContent === "curl");
    const create = $$("#api-admin-posts details.api-route")[1]!;
    // No session in this harness, so the dev token stands in for Access.
    expect(curlOf(create)?.querySelector("code")?.textContent).toBe(
      [
        `curl -X POST "${location.origin}/api/posts"`,
        '  -H "Authorization: Bearer $TOKEN"',
        '  -H "Content-Type: application/json"',
        `  -d '{"subject":"Owls"}'`,
      ].join(" \\\n"),
    );
    expect(curlOf($("#api-webhook-delivery details.api-route"))).toBeUndefined();
  });

  it("copies a code block's plain text, not its highlighted markup, and shows a check for a moment", async () => {
    const writeText = stubClipboard();
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    vi.useFakeTimers();
    const create = $$("#api-admin-posts details.api-route")[1]!;
    const copy = $<HTMLButtonElement>(".block button.copy-btn", create);
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
  });

  it("lists the body types and fields a write accepts and the refusals a route gives, and none where it has none", async () => {
    const withBodies: ReferenceGroup[] = [
      {
        ...groups[0]!,
        resources: [{ key: "posts", title: "Posts" }],
        routes: [
          {
            method: "POST",
            path: "/api/posts/:id/images",
            access: "admin",
            resource: "posts",
            title: "Upload an image",
            summary: "Upload an image.",
            accepts: ["multipart/form-data", "image/png"],
            body: [
              { name: "file", type: "file", required: true, description: "The image." },
              { name: "filename", type: "string", description: "A <name> to store it under." },
            ],
          },
          {
            method: "DELETE",
            path: "/api/posts/:id",
            access: "admin",
            resource: "posts",
            title: "Delete a draft",
            summary: "Delete a draft.",
            errors: [
              {
                status: 409,
                code: "post_not_draft",
                when: "The post is <scheduled>.",
                details: ["send", "field"],
              },
            ],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withBodies) }]);
    await mount(renderReference);
    await settle();
    const [upload, del] = $$(".api-route");
    expect($$(".api-accepts code", upload!).map((c) => c.textContent)).toEqual([
      "multipart/form-data",
      "image/png",
    ]);
    expect(del!.querySelector(".api-accepts")).toBeNull();
    // Each body field with its type, the required one marked; the text stays text.
    expect($$(".api-body tr", upload!).map((tr) => tr.textContent)).toEqual([
      "file requiredfileThe image.",
      "filenamestringA <name> to store it under.",
    ]);
    expect(upload!.querySelector(".api-body name")).toBeNull();
    expect(del!.querySelector(".api-body")).toBeNull();
    // The route's own refusals: status and code, then when, with the fields the body carries.
    expect($$(".api-errors tr", del!).map((tr) => tr.textContent)).toEqual([
      "409 post_not_draftThe post is <scheduled>. With send, field.",
    ]);
    expect(upload!.querySelector(".api-errors")).toBeNull();
  });

  it("describes what every route shares once: the topics, the refusal codes, and each object first under its resource", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // A topic's paragraphs, as text, the refusal table under Errors.
    expect($$("#api-overview-errors .api-prose").map((p) => p.textContent)).toEqual([
      "A refusal names its <field>.",
      "Every code, by what to do next:",
    ]);
    expect(document.querySelector("#api-overview-errors .api-prose field")).toBeNull();
    // The object is one collapsed line, first under the resource whose routes return it.
    const object = $<HTMLDetailsElement>("#api-admin-sends > details.api-object");
    expect(object.id).toBe("api-objects-send");
    expect(object.open).toBe(false);
    expect($(".api-object-sum", object).textContent?.replace(/\s+/g, " ").trim()).toBe(
      "The send view1 field",
    );
    // The refusal table, each group led by its next move.
    expect($$(".api-refusals tr").map((tr) => tr.textContent)).toEqual([
      "Nothing: the act no longer applies",
      "409 window_closedThe fire time has passed.",
    ]);
    expect($(".api-refusals tr.api-move th").getAttribute("colspan")).toBe("2");
    // An object's fields, an enum's values under its line, and its example.
    expect($$("#api-objects-send .api-fields tr").map((tr) => tr.textContent)).toEqual([
      "statusstringIts state.scheduled Cancelable.",
    ]);
    expect($$("#api-objects-send .block-label").map((l) => l.textContent)).toEqual(["Example"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("links what a route returns to its object, and fills a refusal's line from the refusal table", async () => {
    const withReturns: ReferenceGroup[] = [
      {
        ...groups[0]!,
        resources: [{ key: "sends", title: "Sends" }],
        routes: [
          {
            method: "POST",
            path: "/api/sends/:id/cancel",
            access: "admin",
            resource: "sends",
            title: "Cancel a send",
            summary: "Cancel a send.",
            returns: {
              object: "send",
              as: "send",
              fields: [
                { name: "changed", type: "boolean", description: "False when nothing changed." },
              ],
            },
            errors: [{ status: 409, code: "window_closed", details: ["send"] }],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withReturns) }]);
    await mount(renderReference);
    await settle();
    const route = $(".api-route");
    expect($(".api-returns", route).textContent).toBe("send: The send view, and:");
    expect($$(".api-fields tr", route).map((tr) => tr.textContent)).toEqual([
      "changedbooleanFalse when nothing changed.",
    ]);
    expect($$(".api-errors tr", route).map((tr) => tr.textContent)).toEqual([
      "409 window_closedThe fire time has passed. With send.",
    ]);
    // The object's link is a real link to its address, and jumps there in place: opened, with
    // focus on its line, the address in the bar, and the room not rendered again.
    const link = $<HTMLAnchorElement>(".api-obj-link", route);
    expect(link.getAttribute("href")).toBe("#/reference/objects-send");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    link.click();
    expect(scroll.mock.instances).toEqual([$("#api-objects-send")]);
    expect($<HTMLDetailsElement>("#api-objects-send").open).toBe(true);
    expect(document.activeElement).toBe($("#api-objects-send > summary"));
    expect(location.hash).toBe("#/reference/objects-send");
    expect(fake.calls).toHaveLength(1);
  });

  it("renders a route's prose as inline Markdown: code, bold, and paragraphs, its HTML as text", async () => {
    const withProse: ReferenceGroup[] = [
      {
        ...groups[0]!,
        resources: [{ key: "sends", title: "Sends" }],
        routes: [
          {
            method: "GET",
            path: "/api/sends/feed",
            access: "admin",
            resource: "sends",
            title: "Follow changes to sends",
            summary: "What changed since `since`.",
            description: "Pass the **cursor** of a read.\n\nA <b>tag</b> stays text.",
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withProse) }]);
    await mount(renderReference);
    await settle();
    expect($(".api-summary").innerHTML).toBe("What changed since <code>since</code>.");
    expect($$(".api-desc").map((p) => p.innerHTML)).toEqual([
      "Pass the <strong>cursor</strong> of a read.",
      "A &lt;b&gt;tag&lt;/b&gt; stays text.",
    ]);
    // The overview's prose too.
    expect($("#api-overview-errors .api-prose").innerHTML).toBe(
      "A refusal names its &lt;field&gt;.",
    );
  });

  it("copies a route's method and path, and a link that opens the reference at it", async () => {
    const writeText = stubClipboard();
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    const route = $("#route-get-api-posts-id");
    $<HTMLButtonElement>(".api-route-tools [aria-label='Copy method and path']", route).click();
    $<HTMLButtonElement>(
      ".api-route-tools [aria-label='Copy a link to this route']",
      route,
    ).click();
    await settle();
    expect(writeText.mock.calls.map(([text]) => text)).toEqual([
      "GET /api/posts/:id",
      `${location.origin}${location.pathname}#/reference/get-api-posts-id`,
    ]);
    // Each row has its own address, from its method and the path to type.
    expect($$("li[data-hay]").map((li) => li.id)).toEqual([
      "route-get-api-posts",
      "route-post-api-posts",
      "route-get-api-posts-id",
      "route-post-api-sends-id-cancel",
      "route-get-subscribe",
    ]);
  });

  it("opens and scrolls to the route its address names, and the filter still narrows from there", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount((root, signal) => renderReference(root, signal, "post-api-sends-id-cancel"));
    await settle();
    const target = $("#route-post-api-sends-id-cancel");
    expect($<HTMLDetailsElement>("details", target).open).toBe(true);
    expect(scroll.mock.instances).toEqual([target]);
    expect($$<HTMLDetailsElement>("details.api-route").filter((d) => d.open)).toHaveLength(1);
    const filter = $<HTMLInputElement>("#apiFilter");
    filter.value = "post create";
    filter.dispatchEvent(new Event("input"));
    expect(
      $$("li[data-hay]")
        .filter((li) => !li.hidden)
        .map((li) => li.id),
    ).toEqual(["route-post-api-posts"]);
    // An address that names no route opens the reference at its top, nothing opened.
    unmount();
    scroll.mockClear();
    await mount((root, signal) => renderReference(root, signal, "get-nothing"));
    await settle();
    expect($$<HTMLDetailsElement>("details.api-route").filter((d) => d.open)).toHaveLength(0);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("clears a filter that hides the object a route's Returns links to, then opens it", async () => {
    const schedule: ReferenceGroup[] = [
      {
        ...groups[0]!,
        routes: [
          ...groups[0]!.routes,
          {
            method: "POST",
            path: "/api/posts/:id/schedule",
            access: "admin",
            resource: "posts",
            title: "Schedule a post",
            summary: "Schedule a post.",
            returns: { object: "send", as: "send" },
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(schedule) }]);
    await mount(renderReference);
    await settle();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const filter = $<HTMLInputElement>("#apiFilter");
    filter.value = "schedule";
    filter.dispatchEvent(new Event("input"));
    // The send view heads Sends, which the filter hid.
    expect($("#api-admin-sends").hidden).toBe(true);
    $<HTMLElement>("#route-post-api-posts-id-schedule .api-obj-link").click();
    expect(filter.value).toBe("");
    expect($("#api-admin-sends").hidden).toBe(false);
    expect($<HTMLDetailsElement>("#api-objects-send").open).toBe(true);
    expect(scroll.mock.instances).toEqual([$("#api-objects-send")]);
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
            title: "Confirm",
            summary: "Confirm.",
            query: [{ name: "token", description: "The link's token.", required: true }],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withToken) }]);
    await mount(renderReference);
    await settle();
    expect($(".api-route .api-query td").textContent).toBe("token required");
    expect($$("code", $$(".block").at(-1)!).at(-1)?.textContent).toBe(
      `curl "${location.origin}/confirm?token=:token"`,
    );
  });

  it("jumps to a tier or a resource from the rail in place, its address in the bar, with focus on its heading", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // Each rail link is a real link to the part it names, so it opens in a new tab as well.
    expect($$<HTMLAnchorElement>("#apiNav a").map((a) => a.getAttribute("href"))).toEqual([
      "#/reference/overview",
      "#/reference/overview-errors",
      "#/reference/admin",
      "#/reference/admin-posts",
      "#/reference/admin-sends",
      "#/reference/public",
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiNav a[data-sec='public']").click();
    expect(document.activeElement).toBe($("#api-public > h2"));
    $("#apiNav a[data-sec='admin-sends']").click();
    expect(scroll.mock.instances).toEqual([$("#api-public"), $("#api-admin-sends")]);
    expect(document.activeElement).toBe($("#api-admin-sends .api-res-head h3"));
    expect(location.hash).toBe("#/reference/admin-sends");
    expect(fake.calls).toHaveLength(1); // the room isn't rendered again
    // A modified click (a new tab) is left to the browser.
    const cmd = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    $("#apiNav a[data-sec='admin-posts']").dispatchEvent(cmd);
    expect(cmd.defaultPrevented).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("opens at the part of the page its address names, with focus there", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount((root, signal) => renderReference(root, signal, "admin-sends"));
    await settle();
    expect(scroll.mock.instances).toEqual([$("#api-admin-sends")]);
    expect(document.activeElement).toBe($("#api-admin-sends .api-res-head h3"));
    // A tier opens none of its rows.
    expect($$<HTMLDetailsElement>("#api-admin-sends details").filter((d) => d.open)).toEqual([]);
    unmount();
    scroll.mockClear();
    await mount((root, signal) => renderReference(root, signal, "objects-send"));
    await settle();
    expect(scroll.mock.instances).toEqual([$("#api-objects-send")]);
    expect($<HTMLDetailsElement>("#api-objects-send").open).toBe(true);
    expect(document.activeElement).toBe($("#api-objects-send > summary"));
    // A route's address focuses its line.
    unmount();
    await mount((root, signal) => renderReference(root, signal, "get-api-posts-id"));
    await settle();
    expect(document.activeElement).toBe($("#route-get-api-posts-id summary"));
  });

  it("lights the rail for the last tier or resource heading scrolled under the bar, and stops following once the room is left", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
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
    // Past the top, the overview and the objects are above the line too.
    const shared = ["api-overview", "api-overview-errors"];
    const scrollTo = (ids: string[]) => {
      scrolled = ids.length ? [...shared, ...ids] : [];
      window.dispatchEvent(new Event("scroll"));
    };
    scrollTo([]);
    expect(active()).toEqual(["overview"]); // at the top, the overview
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
    scrollY.mockRestore(); // back at the top, for what follows
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

  it("filters rows by name, method, path, or summary, with the headings and rail links that still hold one", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
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

    expect(filter.placeholder).toBe("Filter by name, path, URL, or error code");
    expect($("#apiFilterClear").hidden).toBe(true);
    type("post create");
    expect($("#apiFilterClear").hidden).toBe(false);
    expect(shown()).toEqual(["POST /api/posts"]);
    expect($("#api-admin-sends").hidden).toBe(true);
    expect($("#api-public").hidden).toBe(true);
    // The topics have no rows to match, so a filter puts them away.
    expect($("#api-overview").hidden).toBe(true);
    expect($$("#apiNav a").map((a) => (a.hidden ? "hidden" : a.dataset.sec))).toEqual([
      "hidden",
      "hidden",
      "admin",
      "admin-posts",
      "hidden",
      "hidden",
    ]);
    expect($("#apiEmpty").hidden).toBe(true);
    // The last tier still shown keeps the last tier's room to scroll up under the bar.
    expect($$(".api-section.api-last").map((sec) => sec.id)).toEqual(["api-admin"]);

    // A route's name is matched too, though neither its path nor its summary says it.
    type("retrieve");
    expect(shown()).toEqual(["GET /api/posts/:id"]);

    type("nothing-matches");
    expect(shown()).toEqual([]);
    expect($("#apiEmpty").hidden).toBe(false);

    // The clear control empties it and hands focus back to the field.
    $("#apiFilterClear").click();
    expect(filter.value).toBe("");
    expect(shown()).toHaveLength(5);
    expect($("#api-overview").hidden).toBe(false);
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

  it("finds a route by a refusal code it gives, the object it returns, or a real URL, and a topic by its title", async () => {
    const findable: ReferenceGroup[] = [
      {
        ...groups[0]!,
        routes: [
          ...groups[0]!.routes,
          {
            method: "POST",
            path: "/api/posts/:id/schedule",
            access: "admin",
            resource: "posts",
            title: "Schedule a post",
            summary: "Schedule it.",
            returns: { object: "send", as: "send" },
            errors: [{ status: 409, code: "stale_revision" }],
          },
          {
            method: "GET",
            path: "/api/posts/:id{[a-z0-9]+}/revisions/:rev?",
            access: "admin",
            resource: "posts",
            title: "Read a revision",
            summary: "One revision.",
          },
        ],
      },
      groups[1]!,
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(findable) }]);
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
        .map((li) => li.id);
    const topics = () =>
      $$("#api-overview .api-res")
        .filter((res) => !res.hidden)
        .map((res) => res.id);

    // A refusal code pasted from a response, though neither path nor summary says it.
    type("stale_revision");
    expect(shown()).toEqual(["route-post-api-posts-id-schedule"]);
    // The object a route returns, by its title.
    type("send view");
    expect(shown()).toEqual(["route-post-api-posts-id-schedule"]);
    // A real URL, the path parameters filled in: only the route it calls, its query dropped.
    type(`${location.origin}/api/posts/abc123/schedule?x=1`);
    expect(shown()).toEqual(["route-post-api-posts-id-schedule"]);
    type("delete /api/posts/abc123");
    expect(shown()).toEqual([]);
    type("get /api/posts/abc123");
    expect(shown()).toEqual(["route-get-api-posts-id"]);
    type("/api/posts/abc123/revisions/r7/");
    expect(shown()).toEqual(["route-get-api-posts-id-revisions-rev"]);
    expect(topics()).toEqual([]);
    expect($("#api-overview").hidden).toBe(true);
    // A topic is found by its title, and Errors by any code in its table.
    type("errors");
    expect(topics()).toEqual(["api-overview-errors"]);
    expect(shown()).toEqual([]);
    expect($("#apiEmpty").hidden).toBe(true);
    expect($("#apiNav a[data-sec='overview-errors']").hidden).toBe(false);
    type("window_closed");
    expect(topics()).toEqual(["api-overview-errors"]);
    // Nothing found points to Getting started, whose link clears the filter to reach it.
    type("nothing-matches");
    expect($("#apiEmpty").hidden).toBe(false);
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiEmpty a[data-sec='overview']").click();
    expect(filter.value).toBe("");
    expect($("#api-overview").hidden).toBe(false);
    expect(document.activeElement).toBe($("#api-overview > h2"));
  });

  it("focuses the filter on / unless the reader is typing elsewhere, and stops listening once the room is left", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
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
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : reference(groups)),
      },
    ]);
    await mount(renderReference);
    await settle();
    expect($("#apiContent .error").textContent).toMatch(/went wrong on the server/);
    $("[data-retry]").click();
    await settle();
    expect($$(".api-section")).toHaveLength(3);
    expect($$("details.api-route")).toHaveLength(5);
    expect(fake.calls).toHaveLength(2);
  });
});
