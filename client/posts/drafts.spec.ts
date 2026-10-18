import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedReads, listReads, sendServer, sendView } from "../test/send_server";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  sendSummary,
  settle,
  typeInto,
} from "../test/support";
import { fmt } from "../ui/format";
import { renderDrafts } from "./drafts";

const page = { total: 2, limit: 50, offset: 0, sort: "", dir: "desc" };
const posts = [
  {
    id: "p1",
    subject: "<b>Owls</b> & co",
    status: "draft",
    email_only: true,
    updated_at: "2026-09-20T10:00:00Z",
    send: null,
    actions: [
      { name: "edit", method: "PUT", path: "/api/posts/p1" },
      { name: "delete", method: "DELETE", path: "/api/posts/p1" },
    ],
  },
  {
    id: "p2",
    subject: "Waxwings",
    status: "scheduled",
    updated_at: "2026-09-21T10:00:00Z",
    send: sendView(sendSummary({ id: "s9", post_id: "p2", status: "sending" })),
    actions: [],
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
  const postReads = () => fake.calls.filter((c) => c.url.pathname === "/api/posts");

  it("lists drafts and scheduled posts within the drafts scope, with subjects shown as text and an email-only post marked", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/api/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
    ]);
    await mount(renderDrafts);
    await settle();
    expect($("h1").textContent).toBe("Drafts");
    expect($$("tr[data-id]")).toHaveLength(2);
    expect($("tr[data-id='p1'] a").textContent).toBe("<b>Owls</b> & co");
    expect(document.querySelector("tr[data-id='p1'] b")).toBeNull(); // markup in a subject stays text
    // Only the exception is marked: an email-only post carries the grey label, a listed one none.
    expect($("tr[data-id='p1'] .email-only-mark").textContent?.trim()).toBe("Email only");
    expect(document.querySelector("tr[data-id='p2'] .email-only-mark")).toBeNull();
    expect(postReads()[0]?.url.searchParams.get("status")).toBe("draft,scheduled");
    expect(fake.unhandled).toEqual([]);
  });

  it("opens the editor on a row click, and the live watch for a post being sent", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      { path: "/api/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
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
      { path: "/api/posts", reply: () => ({ posts, page, cursor: "0.0" }) },
    ]);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(0);
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
      {
        path: "/api/posts",
        reply: () => ({ posts: [], page: { ...page, total: 0 }, cursor: "0.0" }),
      },
    ]);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#list").textContent).toMatch(/Create your first draft/);
    typeInto($<HTMLInputElement>(".lt-search"), "zzz");
    await vi.advanceTimersByTimeAsync(300);
    expect($("#list").textContent).toMatch(/No drafts match/);
  });

  it("shows the error with a retry that reloads", async () => {
    let failures = 1;
    fake = fakeApi([
      ...sendServer().routes,
      {
        path: "/api/posts",
        reply: () =>
          failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { posts, page, cursor: "0.0" },
      },
    ]);
    await mount(renderDrafts);
    await settle();
    expect($("#list .error").textContent).toMatch(/went wrong on the server/);
    $("[data-retry]").click();
    await settle();
    expect($$("tr[data-id]")).toHaveLength(2);
  });

  it("creates a new post and opens it", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      {
        path: "/api/posts",
        reply: () => ({ posts: [], page: { ...page, total: 0 }, cursor: "0.0" }),
      },
      {
        method: "POST",
        path: "/api/posts",
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
    // The listed post p2's send, an hour out.
    const row = sendSummary({ id: "s2", post_id: "p2", subject: "Waxwings" });
    const sends = sendServer([row]);
    let failing = false;
    const cursors: string[] = [];
    // The listed post carries its send as the send routes hold it, as the server's list does.
    const listed = () => [posts[0], { ...posts[1], send: sends.view("s2") }];
    return {
      routes: [
        ...sends.routes,
        {
          path: "/api/posts",
          reply: () => {
            if (failing) {
              return jsonResponse({ error: "down" }, 500);
            }
            cursors.push(sends.cursor());
            return { posts: listed(), page, cursor: sends.cursor() };
          },
        },
      ],
      /** The cursor each list read was handed, in order. */
      cursors,
      start() {
        sends.edit("s2", { status: "sending", started_at: Date.now() });
      },
      /** A batch lands while it sends: its counters move, nothing Drafts shows. */
      progress(accepted: number) {
        sends.edit("s2", { status: "sending", started_at: Date.now(), c_accepted: accepted });
      },
      /** Claude moves it. */
      move(at: number) {
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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(listReads(fake)).toEqual([]); // no second read
    expect(feedReads(fake)[0]?.url.searchParams.get("since")).toBe(post.cursors[0]);
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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect($("#list .error").textContent).toMatch(/went wrong on the server/);
    expect(feedReads(fake)).toEqual([]);
    post.recover();
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(feedReads(fake)).toHaveLength(1);
  });

  it("keeps the list when a re-read after a send changed fails", async () => {
    vi.useFakeTimers();
    const post = scheduledPost();
    fake = fakeApi(post.routes);
    await mount(renderDrafts);
    await vi.advanceTimersByTimeAsync(0);
    post.fail();
    post.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postReads()).toHaveLength(2);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(document.querySelector("#list .error")).toBeNull();
  });
});
