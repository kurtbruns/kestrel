import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  typeInto,
} from "../test/support";
import { renderDrafts } from "./drafts";

const page = { total: 2, limit: 50, offset: 0, sort: "", dir: "desc" };
const posts = [
  { id: "p1", subject: "<b>Owls</b> & co", status: "draft", updated_at: "2026-09-20T10:00:00Z" },
  {
    id: "p2",
    subject: "Waxwings",
    status: "scheduled",
    scheduled_for: "2026-09-25T15:00:00Z",
    updated_at: "2026-09-21T10:00:00Z",
    active_send_status: "sending",
    active_send_id: "s9",
  },
];

describe("drafts view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/drafts";
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });

  it("lists drafts and scheduled posts within the drafts scope, with subjects shown as text", async () => {
    fake = fakeApi([{ path: "/posts", reply: () => ({ posts, page }) }]);
    await mount(renderDrafts);
    await settle();
    expect($("h1").textContent).toBe("Drafts");
    expect($$("tr[data-id]")).toHaveLength(2);
    expect($("tr[data-id='p1'] a").textContent).toBe("<b>Owls</b> & co");
    expect(document.querySelector("tr[data-id='p1'] b")).toBeNull(); // markup in a subject stays text
    expect(fake.calls[0]?.url.searchParams.get("status")).toBe("draft,scheduled");
    expect(fake.unhandled).toEqual([]);
  });

  it("opens the editor on a row click, and the live watch for a post being sent", async () => {
    fake = fakeApi([{ path: "/posts", reply: () => ({ posts, page }) }]);
    await mount(renderDrafts);
    await settle();
    $("tr[data-id='p1'] td:last-child").click();
    expect(location.hash).toBe("#/edit/p1");
    $("tr[data-id='p2'] td:last-child").click();
    expect(location.hash).toBe("#/sent/s9");
  });

  it("searches from page one after the debounce", async () => {
    vi.useFakeTimers();
    fake = fakeApi([{ path: "/posts", reply: () => ({ posts, page }) }]);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    typeInto($<HTMLInputElement>(".lt-search"), "wax");
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.url.searchParams.get("search")).toBe("wax");
    expect(fake.calls[1]?.url.searchParams.get("offset")).toBe("0");
  });

  it("shows the empty state, and says so differently when a filter narrowed it", async () => {
    vi.useFakeTimers();
    fake = fakeApi([{ path: "/posts", reply: () => ({ posts: [], page: { ...page, total: 0 } }) }]);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#list").textContent).toMatch(/create your first draft/);
    typeInto($<HTMLInputElement>(".lt-search"), "zzz");
    await vi.advanceTimersByTimeAsync(300);
    expect($("#list").textContent).toMatch(/No drafts match/);
  });

  it("shows the error with a retry that reloads", async () => {
    let failures = 1;
    fake = fakeApi([
      {
        path: "/posts",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { posts, page }),
      },
    ]);
    await mount(renderDrafts);
    await settle();
    expect($("#list .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await settle();
    expect($$("tr[data-id]")).toHaveLength(2);
  });

  it("creates a new post and opens it", async () => {
    fake = fakeApi([
      { path: "/posts", reply: () => ({ posts: [], page: { ...page, total: 0 } }) },
      {
        method: "POST",
        path: "/posts",
        reply: (req) => ({ post: { id: "p9", ...(req.json() as object) } }),
      },
    ]);
    await mount(renderDrafts);
    await settle();
    $("#newPost").click();
    await settle();
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe(`{"subject":"Untitled"}`);
    expect(location.hash).toBe("#/edit/p9");
  });
});
