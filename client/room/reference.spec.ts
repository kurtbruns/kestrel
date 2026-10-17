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
      text: "A refusal names its <field>.\n\nThe status:\n- `4xx`: refused.",
      fields: [{ name: "error", type: "string", description: "Its code." }],
    },
  ],
  statuses: [{ status: 409, name: "Conflict", meaning: "Its `state` refuses it." }],
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
    location.hash = "#/api-reference";
  });
  afterEach(() => {
    fake?.restore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lays out each tier's resources with every route in full, and a rail of tiers, resources, and routes", async () => {
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
    expect($("#api-admin-posts .api-res-head").textContent?.trim()).toBe("Posts");
    // The rail lists a tier's resources only when it has more than one.
    const nav = $$("#apiNav a.api-nav-tier, #apiNav a.api-nav-res");
    expect(nav.map((a) => a.dataset.sec)).toEqual([
      "overview",
      "overview-errors",
      "admin",
      "admin-posts",
      "admin-sends",
      "public",
    ]);
    expect(nav.map((a) => a.textContent)).toEqual([
      "Introduction",
      "Errors",
      "Admin",
      "Posts",
      "Sends",
      "Public",
    ]);
    // Under each resource, its object and routes by name, linked to their own addresses.
    expect(
      $$("#apiNav .api-nav-ops").map((g) => [
        g.dataset.of,
        $$("a", g).map((a) => a.getAttribute("href")),
      ]),
    ).toEqual([
      [
        "admin-posts",
        [
          "#/api-reference/list-posts",
          "#/api-reference/create-post",
          "#/api-reference/retrieve-post",
        ],
      ],
      ["admin-sends", ["#/api-reference/objects-send", "#/api-reference/cancel-send"]],
      ["public-subscriptions", ["#/api-reference/subscribe"]],
    ]);
    expect($(".api-head p").textContent).toContain(`Base URL ${location.origin}.`);
    // Every route is laid out in full: its name, then its badge and path.
    const rows = $$("#api-admin-posts li[data-route]");
    expect(rows).toHaveLength(3);
    expect(document.querySelector("details.api-route")).toBeNull();
    expect($(".api-method", rows[0]).className).toBe("api-method m-GET");
    expect($(".api-path", rows[0]).textContent).toBe("/api/posts");
    expect($(".api-op-head h4", rows[0]).textContent?.trim()).toBe("List posts");
    expect($(".api-op-head", rows[0]).textContent).not.toContain("List posts.");
    expect(document.querySelector(".api-tier")).toBeNull(); // the tier heads the section, not each row
    // A path parameter is marked; the rest of the path is text.
    expect($(".api-path", rows[2]).textContent).toBe("/api/posts/:id");
    expect($$(".api-param", rows[2]).map((p) => p.textContent)).toEqual([":id"]);
    // The detail: summary, description, query, then the examples that exist.
    expect($(".api-desc", rows[0]).textContent).toBe("Offset-paged.");
    expect($(".api-query code.api-row-name", rows[0]).textContent).toBe("status");
    expect($(".api-summary", rows[1]).textContent).toBe("Create <a post>."); // text, not markup
    expect($(".api-op-head h4", rows[1]).textContent?.trim()).toBe("Create <a post>");
    expect(
      document.querySelector(".api-summary a, .api-op-head h4 a:not(.api-self), .api-self a"),
    ).toBeNull();
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
        resources: [{ key: "sends", title: "Sends" }],
        routes: [
          {
            method: "POST",
            path: "/webhooks/ses",
            access: "webhook",
            resource: "sends",
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
    const create = $$("#api-admin-posts li[data-route]")[1]!;
    // No session in this harness, so the dev token stands in for Access.
    expect(curlOf(create)?.querySelector("code")?.textContent).toBe(
      [
        `curl -X POST "${location.origin}/api/posts"`,
        '  -H "Authorization: Bearer $TOKEN"',
        '  -H "Content-Type: application/json"',
        `  -d '{"subject":"Owls"}'`,
      ].join(" \\\n"),
    );
    expect(curlOf($("#api-webhook-sends li[data-route]"))).toBeUndefined();
  });

  it("copies a code block's plain text, not its highlighted markup, and shows a check for a moment", async () => {
    const writeText = stubClipboard();
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    vi.useFakeTimers();
    const create = $$("#api-admin-posts li[data-route]")[1]!;
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
                move: "Nothing: the act no longer applies",
              },
            ],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withBodies) }]);
    await mount(renderReference);
    await settle();
    const [upload, del] = $$("li[data-route]");
    // The body's media types sit in its label, from the registration the router enforces.
    expect(
      $(".api-body", upload!).closest(".block")?.querySelector(".block-label")?.textContent,
    ).toBe("Body · multipart/form-data, image/png");
    // Each body field a row: its name, type, and Required on one line, then what it means;
    // the text stays text.
    expect($$(".api-body .api-row", upload!).map((r) => r.textContent)).toEqual([
      "filefileRequiredThe image.",
      "filenamestringA <name> to store it under.",
    ]);
    expect($(".api-body .api-row-head .api-req", upload!).textContent).toBe("Required");
    expect(upload!.querySelector(".api-body name")).toBeNull();
    expect(del!.querySelector(".api-body")).toBeNull();
    // The route's own refusals, a ledger: the status in a column of its own, tinted by its
    // class, then the code, the fields the body carries, when, and what to do next.
    expect($$(".api-errors .api-lrow", del!).map((r) => r.textContent)).toEqual([
      "409post_not_draftwith send, fieldThe post is <scheduled>.Nothing: the act no longer applies",
    ]);
    expect($(".api-errors .api-st", del!).className).toBe("api-st api-st-4xx");
    expect($(".api-errors .api-move-next", del!).textContent).toBe(
      "Nothing: the act no longer applies",
    );
    expect(upload!.querySelector(".api-errors")).toBeNull();
  });

  it("describes what every route shares once: the topics, the statuses, the refusals any route can give, and each object first under its resource", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // A topic's paragraphs, as text, a paragraph's `- ` lines as a list; under Errors, the
    // status summary, then the error body's fields, then the refusal table.
    expect($$("#api-overview-errors .api-prose").map((p) => p.textContent)).toEqual([
      "A refusal names its <field>.",
      "The status:",
      "4xx: refused.",
    ]);
    expect($("#api-overview-errors ul.prose-list li").innerHTML).toBe("<code>4xx</code>: refused.");
    expect($$("#api-overview-errors .block-label").map((l) => l.textContent)).toEqual([
      "Status codes",
      "The error body",
      "Refusals any route can give",
    ]);
    expect($$(".api-statuses .api-lrow").map((r) => r.textContent)).toEqual([
      "409ConflictIts state refuses it.",
    ]);
    expect($$("#api-overview-errors .api-fields .api-row").map((r) => r.textContent)).toEqual([
      "errorstringIts code.",
    ]);
    expect(document.querySelector("#api-overview-errors .api-prose field")).toBeNull();
    // The object is laid out like a route, first under the resource whose routes return it,
    // marked Object where a route shows its verb.
    const object = $("#api-admin-sends > article.api-object");
    expect(object.id).toBe("api-objects-send");
    expect($(".api-method", object).textContent).toBe("Object");
    expect($(".api-op-head h4", object).textContent?.trim()).toBe("The send view");
    expect($(".api-path", object).textContent).toBe("1 field");
    // Errors lists only the refusals no route lists as its own; there
    // is no table of every code.
    expect(document.querySelector(".api-fold")).toBeNull();
    expect($$(".api-refusals .api-lrow").map((r) => r.textContent)).toEqual([
      "409window_closedThe fire time has passed.",
    ]);
    // Unlike a route's own refusals, these carry no next move: the status and line say it.
    expect(document.querySelector(".api-refusals .api-move-next")).toBeNull();
    // A code breaks only where its words join.
    expect($(".api-refusals code.api-row-name").innerHTML).toBe("window_<wbr>closed");
    // An object's fields, an enum's values under its line, and its example.
    expect($$("#api-objects-send .api-fields .api-row").map((r) => r.textContent)).toEqual([
      "statusstringIts state.scheduled Cancelable.",
    ]);
    expect($$("#api-objects-send .block-label").map((l) => l.textContent)).toEqual(["Example"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("lists an enum's values that fall into groups under each group's name", async () => {
    const [send] = shared.objects;
    const values = [
      { value: "outage", description: "Down.", group: "An `unavailable` halt" },
      { value: "sandbox", description: "In the sandbox.", group: "An `account` halt" },
      { value: "quota", description: "Over quota.", group: "An `account` halt" },
    ];
    const fields = [{ name: "cause", type: "string", description: "Why.", values }];
    fake = fakeApi([
      {
        path: "/api/reference",
        reply: () => ({ ...reference(groups), objects: [{ ...send!, fields }] }),
      },
    ]);
    await mount(renderReference);
    await settle();
    const desc = $("#api-objects-send .api-fields .api-row-desc");
    expect($$(".api-values-group", desc).map((g) => g.innerHTML)).toEqual([
      "An <code>unavailable</code> halt",
      "An <code>account</code> halt",
    ]);
    expect($$("ul.api-values", desc).map((ul) => $$("li", ul).map((li) => li.textContent))).toEqual(
      [["outage Down."], ["sandbox In the sandbox.", "quota Over quota."]],
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("links a field that holds an object to that object's section, by its type", async () => {
    const [send] = shared.objects;
    const fields = [
      ...send!.fields,
      { name: "conditions", type: "send[]", object: "send" as const, description: "Its kin." },
    ];
    fake = fakeApi([
      {
        path: "/api/reference",
        reply: () => ({ ...reference(groups), objects: [{ ...send!, fields }] }),
      },
    ]);
    await mount(renderReference);
    await settle();
    const link = $<HTMLAnchorElement>(
      "#api-objects-send .api-fields .api-row:last-child .api-row-type a",
    );
    expect(link.textContent).toBe("send[]");
    expect(link.getAttribute("href")).toBe("#/api-reference/objects-send");
    expect(fake.unhandled).toEqual([]);
  });

  it("sets an object's value table as rows: short cells beside the name, long ones beneath, the later labelled", async () => {
    const [send] = shared.objects;
    const tables = [
      {
        title: "Condition kinds",
        description: "Each `kind`.",
        columns: ["Kind", "Severity", "Meaning", "Remedy"],
        rows: [
          [
            "`provider_unavailable`",
            "`info`",
            "An outage, retried at `retry_at`. ".repeat(3).trim(),
            "Nothing: it retries on its own, so no one has to act while it waits.".repeat(2),
          ],
        ],
      },
    ];
    fake = fakeApi([
      {
        path: "/api/reference",
        reply: () => ({ ...reference(groups), objects: [{ ...send!, tables }] }),
      },
    ]);
    await mount(renderReference);
    await settle();
    const sec = $(".api-value-rows", $("#api-objects-send")).closest(".api-sec")!;
    expect($(".block-label", sec).textContent).toBe("Condition kinds");
    expect($(".api-prose", sec).textContent).toBe("Each kind.");
    expect(sec.querySelector("table")).toBeNull();
    const row = $(".api-value-rows .api-row", sec);
    expect($("code.api-row-name", row).innerHTML).toBe("provider_<wbr>unavailable");
    expect($(".api-row-meta", row).innerHTML).toBe(
      '<span class="api-row-key">Severity</span> <code>info</code>',
    );
    const lines = $$(".api-row-desc", row);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.querySelector(".api-row-key")).toBeNull();
    expect($(".api-row-key", lines[1]!).textContent).toBe("Remedy:");
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
            errors: [
              {
                status: 409,
                code: "window_closed",
                details: ["send"],
                move: "Nothing: the act no longer applies",
              },
            ],
          },
        ],
      },
    ];
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(withReturns) }]);
    await mount(renderReference);
    await settle();
    const route = $("li[data-route]");
    expect($(".api-returns", route).textContent).toBe("send: The send view, and:");
    expect($$(".api-fields .api-row", route).map((r) => r.textContent)).toEqual([
      "changedbooleanFalse when nothing changed.",
    ]);
    expect($$(".api-errors .api-lrow", route).map((r) => r.textContent)).toEqual([
      "409window_closedwith sendThe fire time has passed.Nothing: the act no longer applies",
    ]);
    // The object's link is a real link to its address, and jumps there in place, with focus on
    // its heading, the address in the bar, and the room not rendered again.
    const link = $<HTMLAnchorElement>(".api-obj-link", route);
    expect(link.getAttribute("href")).toBe("#/api-reference/objects-send");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    link.click();
    expect(scroll.mock.instances).toEqual([$("#api-objects-send")]);
    expect(document.activeElement).toBe($("#api-objects-send h4"));
    expect(location.hash).toBe("#/api-reference/objects-send");
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

  it("copies a route's path from beside it, and makes its heading a link to its own address", async () => {
    const writeText = stubClipboard();
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    const route = $("#route-retrieve-post");
    // Copy sits right after the path and copies the path alone; the method is the client's
    // own argument, and the curl block carries the whole call.
    const copy = $<HTMLButtonElement>(
      ".api-op-call .api-path + button[aria-label='Copy path']",
      route,
    );
    copy.click();
    await settle();
    expect(writeText.mock.calls.map(([text]) => text)).toEqual(["/api/posts/:id"]);
    // No separate Copy link: the heading is the link, its icon shown on hover.
    expect(route.querySelector("[aria-label='Copy a link to this route']")).toBeNull();
    const self = $<HTMLAnchorElement>("h4 a.api-self", route);
    expect(self.getAttribute("href")).toBe("#/api-reference/retrieve-post");
    expect(self.querySelector("svg")).not.toBeNull();
    // Every heading with an address links to it: a tier, a resource, an object, a topic.
    expect($$("a.api-self[data-sec]").map((a) => a.getAttribute("href"))).toEqual([
      "#/api-reference/overview-errors",
      "#/api-reference/admin",
      "#/api-reference/admin-posts",
      "#/api-reference/admin-sends",
      "#/api-reference/objects-send",
      "#/api-reference/public",
      "#/api-reference/public-subscriptions",
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    self.click();
    expect(scroll.mock.instances).toEqual([route]);
    expect(location.hash).toBe("#/api-reference/retrieve-post");
    // Each row has its own address, named for what it does.
    expect($$("li[data-hay]").map((li) => li.id)).toEqual([
      "route-list-posts",
      "route-create-post",
      "route-retrieve-post",
      "route-cancel-send",
      "route-subscribe",
    ]);
  });

  it("scrolls to the route its address names, with focus on its heading, and the filter still narrows from there", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount((root, signal) => renderReference(root, signal, "cancel-send"));
    await settle();
    const target = $("#route-cancel-send");
    expect(scroll.mock.instances).toEqual([target]);
    expect(document.activeElement).toBe($("h4", target));
    const filter = $<HTMLInputElement>("#apiFilter");
    filter.value = "post create";
    filter.dispatchEvent(new Event("input"));
    expect(
      $$("li[data-hay]")
        .filter((li) => !li.hidden)
        .map((li) => li.id),
    ).toEqual(["route-create-post"]);
    // An address that names no route opens the reference at its top.
    unmount();
    scroll.mockClear();
    await mount((root, signal) => renderReference(root, signal, "get-nothing"));
    await settle();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("clears a filter that hides the object a route's Returns links to, then goes to it", async () => {
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
    $<HTMLElement>("#route-schedule-post .api-obj-link").click();
    expect(filter.value).toBe("");
    expect($("#api-admin-sends").hidden).toBe(false);
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
    expect($("li[data-route] .api-query .api-row-head").textContent).toBe("tokenRequired");
    expect($$("code", $$(".block").at(-1)!).at(-1)?.textContent).toBe(
      `curl "${location.origin}/confirm?token=:token"`,
    );
  });

  it("jumps to a tier or a resource from the rail in place, its address in the bar, with focus on its heading", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // Each rail link is a real link to the part it names, so it opens in a new tab as well.
    expect(
      $$<HTMLAnchorElement>("#apiNav a.api-nav-tier, #apiNav a.api-nav-res").map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual([
      "#/api-reference",
      "#/api-reference/overview-errors",
      "#/api-reference/admin",
      "#/api-reference/admin-posts",
      "#/api-reference/admin-sends",
      "#/api-reference/public",
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiNav a[data-sec='public']").click();
    expect(document.activeElement).toBe($("#api-public > h2"));
    $("#apiNav a[data-sec='admin-sends']").click();
    expect(scroll.mock.instances).toEqual([$("#api-public"), $("#api-admin-sends")]);
    expect(document.activeElement).toBe($("#api-admin-sends .api-res-head h3"));
    expect(location.hash).toBe("#/api-reference/admin-sends");
    expect(fake.calls).toHaveLength(1); // the room isn't rendered again
    // The Introduction goes back to the very top of the page, not to its title under the bar,
    // focus on its title.
    const top = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    $("#apiNav a[data-sec='overview']").click();
    expect(top).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement).toBe($("#api-intro > h1"));
    expect(location.hash).toBe("#/api-reference");
    // A route's link in the rail goes to the route, focus on its heading.
    $("#apiNav a[data-route='cancel-send']").click();
    expect(document.activeElement).toBe($("#route-cancel-send h4"));
    expect(location.hash).toBe("#/api-reference/cancel-send");
    // A modified click (a new tab) is left to the browser.
    const cmd = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    $("#apiNav a[data-sec='admin-posts']").dispatchEvent(cmd);
    expect(cmd.defaultPrevented).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(3);
  });

  it("opens at the part of the page its address names, with focus there", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount((root, signal) => renderReference(root, signal, "admin-sends"));
    await settle();
    expect(scroll.mock.instances).toEqual([$("#api-admin-sends")]);
    expect(document.activeElement).toBe($("#api-admin-sends .api-res-head h3"));
    unmount();
    scroll.mockClear();
    await mount((root, signal) => renderReference(root, signal, "objects-send"));
    await settle();
    expect(scroll.mock.instances).toEqual([$("#api-objects-send")]);
    expect(document.activeElement).toBe($("#api-objects-send h4"));
    // A route's address focuses its heading.
    unmount();
    await mount((root, signal) => renderReference(root, signal, "retrieve-post"));
    await settle();
    expect(document.activeElement).toBe($("#route-retrieve-post h4"));
  });

  it("lights the rail for the last heading scrolled under the bar, opens its resource's routes there, and stops following once the room is left", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // No layout here, so place the headings by hand: `scrolled` names the last ones above the
    // line, and everything before them in the page is above it too, as on a real page.
    let scrolled: string[] = [];
    const marks = $$(".api-section, .api-res, .api-object, li[data-route]");
    for (const [i, el] of marks.entries()) {
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => {
        const last = Math.max(-1, ...scrolled.map((id) => marks.findIndex((m) => m.id === id)));
        return { top: i <= last ? 0 : 1000 } as DOMRect;
      });
    }
    const nav = $("#apiNav");
    const active = () => $$("a.active", nav).map((a) => a.dataset.sec ?? a.dataset.route);
    const opened = () => $$(".api-nav-ops.open", nav).map((g) => g.dataset.of);
    // Past the top, the overview and the objects are above the line too.
    const shared = ["api-overview", "api-overview-errors"];
    const scrollTo = (ids: string[]) => {
      scrolled = ids.length ? [...shared, ...ids] : [];
      window.dispatchEvent(new Event("scroll"));
    };
    scrollTo([]);
    expect(active()).toEqual(["overview"]); // at the top, the overview
    expect(opened()).toEqual([]);
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["admin-sends"]);
    // In a resource, the rail lists its routes and lights the one the reader is in.
    expect(opened()).toEqual(["admin-sends"]);
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends", "api-objects-send"]);
    expect(active()).toEqual(["objects-send"]);
    scrollTo([
      "api-admin",
      "api-admin-posts",
      "route-list-posts",
      "api-admin-sends",
      "api-objects-send",
      "route-cancel-send",
    ]);
    expect(active()).toEqual(["cancel-send"]);
    expect(opened()).toEqual(["admin-sends"]);
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
    // Scrolled, the address follows the reader with no history entry; at the top it is the
    // reference's own.
    const away = vi.spyOn(window, "scrollY", "get").mockReturnValue(300);
    const tall = vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(9000);
    const entries = history.length;
    scrollTo(["api-admin", "api-admin-posts", "route-list-posts"]);
    expect(location.hash).toBe("#/api-reference/list-posts");
    scrollTo(["api-admin", "api-admin-posts"]);
    expect(location.hash).toBe("#/api-reference/admin-posts");
    expect(history.length).toBe(entries);
    away.mockRestore();
    tall.mockRestore();
    scrollTo([]);
    expect(location.hash).toBe("#/api-reference");
    // At the bottom of a scrolled page the last heading wins, even one short of the line.
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(500);
    const height = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(window.innerHeight + 500);
    scrollTo(["api-admin"]);
    expect(active()).toEqual(["subscribe"]);
    scrollY.mockRestore(); // back at the top, for what follows
    height.mockRestore();
    // A filtered-out heading is skipped, and with nothing left the rail lights nothing.
    $("#api-admin-sends").hidden = true;
    scrollTo(["api-admin", "api-admin-posts", "api-admin-sends"]);
    expect(active()).toEqual(["retrieve-post"]);
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

  it("keeps a resource's address after a jump to it, though its first object sits just below its heading", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    // Laid out as just after a jump to Sends: its heading at the bar's foot (54px when the bar
    // measures nothing here), the send view one heading's height below it.
    const at: Record<string, number> = { "api-admin-sends": 54, "api-objects-send": 97 };
    for (const el of $$(".api-section, .api-res, .api-object, li[data-route]")) {
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            top: at[el.id] ?? (el.compareDocumentPosition($("#api-admin-sends")) & 2 ? 2000 : 0),
          }) as DOMRect,
      );
    }
    vi.spyOn(window, "scrollY", "get").mockReturnValue(4000);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(99999);
    window.dispatchEvent(new Event("scroll"));
    expect(location.hash).toBe("#/api-reference/admin-sends");
    expect($("#apiNav a.active").dataset.sec).toBe("admin-sends");
  });

  it("filters rows by name, method, path, or summary, with the headings and rail links that still hold one", async () => {
    fake = fakeApi([{ path: "/api/reference", reply: () => reference(groups) }]);
    await mount(renderReference);
    await settle();
    const filter = $<HTMLInputElement>("#apiFilter");
    const nav = $("#apiNav");
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
    expect(
      $$("#apiNav a.api-nav-tier, #apiNav a.api-nav-res").map((a) =>
        a.hidden ? "hidden" : a.dataset.sec,
      ),
    ).toEqual(["hidden", "hidden", "admin", "admin-posts", "hidden", "hidden"]);
    // The rail lists every route that matches, in whatever resource, and only those; an
    // object is listed only while its resource still holds a match.
    expect(nav.classList.contains("filtering")).toBe(true);
    expect($("#apiNav a[data-sec='objects-send']").hidden).toBe(true);
    expect(
      $$("#apiNav a[data-route]")
        .filter((a) => !a.hidden)
        .map((a) => a.dataset.route),
    ).toEqual(["create-post"]);
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
    expect(nav.classList.contains("filtering")).toBe(false);
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
            errors: [{ status: 409, code: "stale_revision", move: "Read again, then decide" }],
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
    expect(shown()).toEqual(["route-schedule-post"]);
    // The object a route returns, by its title.
    type("send view");
    expect(shown()).toEqual(["route-schedule-post"]);
    // A real URL, the path parameters filled in: only the route it calls, its query dropped.
    type(`${location.origin}/api/posts/abc123/schedule?x=1`);
    expect(shown()).toEqual(["route-schedule-post"]);
    type("delete /api/posts/abc123");
    expect(shown()).toEqual([]);
    type("get /api/posts/abc123");
    expect(shown()).toEqual(["route-retrieve-post"]);
    type("/api/posts/abc123/revisions/r7/");
    expect(shown()).toEqual(["route-read-revision"]);
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
    // Nothing found points to the Introduction, whose link clears the filter and goes to the top.
    type("nothing-matches");
    expect($("#apiEmpty").hidden).toBe(false);
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#apiEmpty a[data-sec='overview']").click();
    expect(filter.value).toBe("");
    expect($("#api-overview").hidden).toBe(false);
    expect(document.activeElement).toBe($("#api-intro > h1"));
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
    expect($$("li[data-route]")).toHaveLength(5);
    expect(fake.calls).toHaveLength(2);
  });
});
