import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendSummary } from "../../shared/sends";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  sendServer,
  settle,
  typeInto,
} from "../test/support";
import { fmt } from "../ui/format";
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
  const postReads = () => fake.calls.filter((c) => c.url.pathname === "/posts");

  it("lists drafts and scheduled posts within the drafts scope, with subjects shown as text", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
    ]);
    await mount(renderDrafts);
    await settle();
    expect($("h1").textContent).toBe("Drafts");
    expect($$("tr[data-id]")).toHaveLength(2);
    expect($("tr[data-id='p1'] a").textContent).toBe("<b>Owls</b> & co");
    expect(document.querySelector("tr[data-id='p1'] b")).toBeNull(); // markup in a subject stays text
    expect(postReads()[0]?.url.searchParams.get("status")).toBe("draft,scheduled");
    expect(fake.unhandled).toEqual([]);
  });

  it("opens the editor on a row click, and the live watch for a post being sent", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
    ]);
    await mount(renderDrafts);
    await settle();
    $("tr[data-id='p1'] td:last-child").click();
    expect(location.hash).toBe("#/edit/p1");
    $("tr[data-id='p2'] td:last-child").click();
    expect(location.hash).toBe("#/sent/s9");
  });

  it("searches from page one after the debounce", async () => {
    vi.useFakeTimers();
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
    ]);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    typeInto($<HTMLInputElement>(".lt-search"), "wax");
    await vi.advanceTimersByTimeAsync(300);
    expect(postReads()).toHaveLength(2);
    expect(postReads()[1]?.url.searchParams.get("search")).toBe("wax");
    expect(postReads()[1]?.url.searchParams.get("offset")).toBe("0");
  });

  it("shows the empty state, and says so differently when a filter narrowed it", async () => {
    vi.useFakeTimers();
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/posts", reply: () => ({ posts: [], page: { ...page, total: 0 }, cursor: "0.0" }) },
    ]);
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
      ...sendServer().routes,
      {
        path: "/posts",
        reply: () =>
          failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { posts, page, cursor: "0.0" },
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
      ...sendServer().routes,
      { path: "/posts", reply: () => ({ posts: [], page: { ...page, total: 0 }, cursor: "0.0" }) },
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
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe("{}"); // no stand-in subject
    expect(location.hash).toBe("#/edit/p9");
  });

  // A post whose send the spec starts: the posts list and the send routes agree.
  function scheduledPost() {
    const row = scheduledRow();
    const sends = sendServer([row]);
    let sending = false;
    let failing = false;
    let fireAt = row.fire_at;
    const listed = () => [
      posts[0],
      {
        ...posts[1],
        fire_at: fireAt,
        active_send_status: sending ? "sending" : "scheduled",
        active_send_id: "s2",
      },
    ];
    return {
      routes: [
        ...sends.routes,
        {
          path: "/posts",
          reply: () =>
            failing
              ? jsonResponse({ error: "down" }, 500)
              : { posts: listed(), page, cursor: sends.cursor() },
        },
      ],
      start() {
        sending = true;
        sends.edit("s2", { status: "sending", started_at: Date.now() });
      },
      /** A batch lands while it sends: its counters move, nothing Drafts shows. */
      progress(accepted: number) {
        sends.edit("s2", { status: "sending", started_at: Date.now(), c_accepted: accepted });
      },
      /** Claude moves it. */
      move(at: number) {
        fireAt = at;
        sends.edit("s2", { fire_at: at });
      },
      fail() {
        failing = true;
      },
      recover() {
        failing = false;
      },
    };
  }

  it("re-reads the list when a listed post's send starts, so it stops reading scheduled", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    expect($("tr[data-id='p2']").textContent).toMatch(/scheduled/i);
    post.start();
    await vi.advanceTimersByTimeAsync(60_000); // within one idle read of the layer
    expect(postReads()).toHaveLength(2);
    expect($("tr[data-id='p2']").textContent).toMatch(/sending/i);
    expect($("tr[data-id='p2']").dataset.target).toBe("#/sent/s2");
    expect(fake.unhandled).toEqual([]);
  });

  it("takes its cursor from its own read of the list, and re-reads only when a listed send's stage or time changes", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.calls.some((c) => c.url.pathname === "/sends")).toBe(false); // no second read
    post.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postReads()).toHaveLength(2); // started: re-read once
    for (let n = 10; n <= 50; n += 10) {
      post.progress(n); // batches land every few seconds while it sends
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(postReads()).toHaveLength(2); // progress alone changes nothing Drafts shows
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a move made elsewhere within an idle read", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    const moved = Date.now() + 2 * 3_600_000;
    post.move(moved);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postReads()).toHaveLength(2);
    expect($("tr[data-id='p2'] .when").textContent).toBe(fmt(moved));
  });

  it("follows once a first read that failed is retried", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    post.fail();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#list .error").textContent).toMatch(/down/);
    expect(fake.calls.some((c) => c.url.pathname === "/sends/feed")).toBe(false);
    post.recover();
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(fake.calls.some((c) => c.url.pathname === "/sends/feed")).toBe(true);
  });

  it("keeps the list when a re-read after a send changed fails", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(10);
    post.fail();
    post.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postReads()).toHaveLength(2);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(document.querySelector("#list .error")).toBeNull();
  });
});

/** The scheduled send of the listed post p2. */
function scheduledRow(): SendSummary {
  return {
    id: "s2",
    post_id: "p2",
    status: "scheduled",
    fire_at: Date.now() + 3_600_000,
    subject: "Waxwings",
    recipient_count: 40,
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
  };
}
