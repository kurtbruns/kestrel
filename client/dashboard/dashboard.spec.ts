import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostListItem } from "../../shared/posts";
import type { LiveSend, SendListItem } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import type { SubscriberCounts } from "../../shared/subscribers";
import { appState } from "../state";
import { confirmUnsubscribe } from "../subscribers/dialogs";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  liveReads,
  liveRoute,
  liveSend,
  mount,
  resetShell,
  unmount,
} from "../test/support";
import { renderDashboard } from "./dashboard";

const NOW = 1_700_000_000_000;
const page = { total: 0, limit: 200, offset: 0, sort: "", dir: "desc" };

const post = (over: Partial<PostListItem> = {}): PostListItem => ({
  id: "p1",
  slug: "owls",
  subject: "<b>Owls</b> & co",
  status: "draft",
  current_revision: "r1",
  created_at: NOW - 100_000,
  updated_at: NOW - 50_000,
  fire_at: null,
  active_send_id: null,
  active_send_status: null,
  author: "human",
  ...over,
});
const send = (over: Partial<SendListItem> = {}): SendListItem => ({
  id: "x1",
  post_id: "p3",
  status: "sent",
  fire_at: NOW - 3_600_000,
  subject: "Waxwings",
  recipient_count: 100,
  locked_until: null,
  scheduled_at: NOW - 7_200_000,
  started_at: NOW - 3_600_000,
  completed_at: NOW - 3_500_000,
  audience_resolved_at: NOW - 3_600_000,
  remade_at: null,
  halt_reason: null,
  halt_cause: null,
  halt_error: null,
  halted_at: null,
  halt_retries: 0,
  halt_retry_at: null,
  c_pending: 0,
  c_in_flight: 0,
  c_accepted: 0,
  c_delivered: 98,
  c_bounced: 2,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 0,
  rev: 1,
  phase: "complete",
  attention: { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: false },
  stuck: false,
  ...over,
});
const counts: SubscriberCounts = { pending: 3, confirmed: 40, unsubscribed: 2, suppressed: 1 };
const none: SubscriberCounts = { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 };

// What the dashboard reads from the boot-time settings: the identity and the origins.
const config = (): SettingsResponse =>
  ({
    settings: { publication: { name: "Birds Weekly", tagline: "Owls & more", logoUrl: "" } },
    deployment: {
      provider: "fake",
      fromAddress: "Birds <hello@birds.example>",
      appOrigin: "https://app.birds.example",
      archiveOrigin: "https://birds.example",
      archiveBasePath: "/archive",
      build: {
        version: "",
        sha: "dev",
        tag: "",
        buildTime: "",
        repoUrl: "",
        commitUrl: "",
        tagUrl: "",
      },
    },
  }) as unknown as SettingsResponse;

// A stateful fake: the sends list filters on `status` like the Worker does, and `live` is what
// the send-state layer reads (GET /sends/live), so every read sees the same world.
function world(
  posts: PostListItem[],
  sends: () => SendListItem[],
  live: () => LiveSend[] = () => [],
  subs = counts,
  next: () => number | null = () => null,
) {
  return fakeApi([
    liveRoute(live, next),
    { path: "/posts", reply: () => ({ posts, page: { ...page, total: posts.length } }) },
    {
      path: "/sends",
      reply: (req) => {
        const status = req.url.searchParams.get("status");
        const rows = sends().filter((s) => !status || s.status === status);
        return { sends: rows, page: { ...page, total: rows.length } };
      },
    },
    { path: "/subscribers", reply: () => ({ counts: subs, subscribers: [], page }) },
  ]);
}

describe("dashboard", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    location.hash = "#/dashboard";
    appState.appConfig = config();
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });

  it("renders the identity, the tiles into the roster, the queue, the drafts, the sent table, and the publication and API cards", async () => {
    const posts = [
      post(),
      post({
        id: "p2",
        slug: "gulls",
        subject: "Gulls",
        status: "scheduled",
        fire_at: NOW + 60_000,
      }),
      post({ id: "p3", slug: "waxwings", subject: "Waxwings", status: "sent" }),
    ];
    const sends = [
      send(),
      send({
        id: "x2",
        post_id: "p2",
        status: "scheduled",
        subject: "Gulls",
        fire_at: NOW + 60_000,
        started_at: null,
        completed_at: null,
        recipient_count: 40,
      }),
    ];
    fake = world(posts, () => sends);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".dash-head h1").textContent).toBe("Birds Weekly");
    expect($(".dash-tagline").textContent).toBe("Owls & more");
    expect(document.querySelector(".health")).toBeNull(); // nothing wrong, nothing said
    expect(document.querySelector("#dashActive .active-card")).toBeNull();
    const tiles = $$<HTMLAnchorElement>(".tile");
    expect(tiles.map((t) => t.getAttribute("href"))).toEqual([
      "#/subscribers/confirmed",
      "#/subscribers/pending",
      "#/subscribers/unsubscribed",
      "#/subscribers/suppressed",
    ]);
    expect(tiles.map((t) => $(".tile-n", t).textContent)).toEqual(["40", "3", "2", "1"]);
    expect(tiles[0]?.classList.contains("tile-emph")).toBe(true);
    const card = $("#dashScheduled .sched-card");
    expect(card.dataset.post).toBe("p2");
    expect($(".countdown", card).textContent).toBe("Sends in 1m 00s");
    expect(card.textContent).toMatch(/40 recipients/);
    expect($("tr[data-id='p1'] a").textContent).toBe("<b>Owls</b> & co"); // a subject is text
    expect(document.querySelector("tr[data-id='p1'] b")).toBeNull();
    expect($$("tr[data-id]")).toHaveLength(1); // drafts only
    const sent = $("tr[data-send='x1']");
    expect($("td a", sent).getAttribute("href")).toBe("#/sent/x1");
    expect($(".badge", sent).textContent).toBe("sent");
    expect($("td.num .n", sent).textContent).toBe("98");
    expect($(".ghost-link", sent).getAttribute("href")).toBe(
      "https://birds.example/archive/waxwings",
    );
    expect($$(".pub-card [data-copy]").map((b) => b.dataset.copy)).toEqual([
      "https://app.birds.example",
      "https://birds.example/archive",
    ]);
    // No service author yet: the guide leads, both links at one weight, each led by its glyph.
    expect($$(".pub-links a").map((a) => a.textContent?.trim())).toEqual([
      "Connect Claude →",
      "API reference →",
    ]);
    expect($$(".pub-links a svg").length).toBe(2);
    expect(fake.unhandled).toEqual([]);
  });

  it("reports Claude as connected once the service principal has authored a revision", async () => {
    fake = world([post({ author: "service" })], () => []);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".conn-status").textContent).toBe("Claude is connected.");
    // The same two links, same shape, once connected: the reference first, each with its glyph.
    expect($$(".pub-links a").map((a) => a.textContent?.trim())).toEqual([
      "API reference →",
      "Connection guide →",
    ]);
    expect($$(".pub-links a svg").length).toBe(2);
    expect($("#dashScheduled").textContent).toBe("Nothing scheduled.");
    expect($$(".dash-section").find((s) => s.textContent?.startsWith("Sent"))?.textContent).toMatch(
      /No sends yet\./,
    );
  });

  it("raises the health line from the server's flags, red for a missed send and a wedged one, and keeps the wedged send out of the active widget", async () => {
    const sends = [
      send({ id: "m1", status: "scheduled", fire_at: NOW - 6 * 60_000, started_at: null }),
      send({ id: "w1", subject: "Kinglets", status: "sending", c_pending: 0, c_in_flight: 2 }),
      send({ id: "ok1", status: "sending", c_pending: 5, started_at: NOW - 11 * 60_000 }),
      send({
        id: "st1",
        status: "sending",
        c_pending: 5,
        c_in_flight: 1,
        started_at: NOW - 31 * 60_000,
        stuck: true,
      }),
    ];
    const [m1, w1, ok1, st1] = sends as [SendListItem, SendListItem, SendListItem, SendListItem];
    // The server decides every flag (SPEC §12): eleven minutes in is not in flight too long,
    // thirty-one is, and a send due six minutes ago is past the missed tolerance.
    const live = [
      liveSend(m1, "due", { attention: { missed: true } }),
      liveSend(w1, "needs-attention", { attention: { wedged: true, wedged_count: 2 } }),
      liveSend(ok1, "progressing"),
      liveSend(st1, "progressing", { attention: { stuck: true } }),
    ];
    fake = world(
      [post()],
      () => sends,
      () => live,
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    const lines = $$(":scope > div > div", health).map((d) => d.textContent);
    expect(lines).toEqual([
      "1 scheduled send passed the fire time without going out.",
      "Kinglets has 2 ambiguous deliveries awaiting a decision; resolve them on its page.",
      "A send has been in progress over 30 minutes — it may be retrying.",
    ]);
    // The wedged line leads to where Resolve is: the send's own page.
    expect($("a", health).getAttribute("href")).toBe("#/sent/w1");
    expect($$("#dashActive .active-card").map((c) => c.dataset.watch)).toEqual(["ok1", "st1"]);
    expect($("[data-watch='st1'] .active-stuck").textContent).toMatch(/over 30 minutes/);
    expect(fake.unhandled).toEqual([]);
  });

  it("calls a due send missed only past the server's tolerance, never at the fire time", async () => {
    const due = send({ id: "d1", status: "scheduled", fire_at: NOW - 30_000, started_at: null });
    fake = world(
      [post()],
      () => [due],
      () => [liveSend(due, "due")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashScheduled .sched-card").dataset.post).toBe("p3");
  });

  it("raises one red line with the provider's words for a refused account, and keeps the send out of the active widget", async () => {
    const refused = (id: string) =>
      send({
        id,
        status: "sending",
        c_pending: 40,
        halt_reason: "account",
        halt_cause: "credentials",
        halt_error: "Resend 401 invalid_api_key: API key is invalid",
        halted_at: NOW - 60_000,
      });
    const sends = [
      refused("r1"),
      refused("r2"),
      send({
        id: "u1",
        status: "sending",
        c_pending: 5,
        started_at: NOW - 60_000,
        halt_reason: "unavailable",
      }),
    ];
    const halt = {
      reason: "account" as const,
      cause: "credentials" as const,
      error: "Resend 401 invalid_api_key: API key is invalid",
      since: NOW - 60_000,
      retry_at: NOW + 240_000,
    };
    const [r1, r2, u1] = sends as [SendListItem, SendListItem, SendListItem];
    const live = [
      liveSend(r1, "needs-attention", { attention: { refused: true }, halt }),
      liveSend(r2, "needs-attention", { attention: { refused: true }, halt }),
      liveSend(u1, "backing-off", {
        halt: { ...halt, reason: "unavailable", cause: "outage", error: "503" },
      }),
    ];
    fake = world(
      [post()],
      () => sends,
      () => live,
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    expect($$(":scope > div > div", health).map((d) => d.textContent)).toEqual([
      "The email provider is refusing this account, pausing 2 sends: Resend 401 invalid_api_key: API key is invalid. Replace the provider's API key or credentials in the deployment's secrets. Sending resumes on its own.",
    ]);
    // Several refused sends link to the Sent page that lists them; one links to its watch.
    expect($("a", health).getAttribute("href")).toBe("#/sent");
    // Only unavailable, which retries on its own: still an ordinary in-progress send.
    expect($$("#dashActive .active-card").map((c) => c.dataset.watch)).toEqual(["u1"]);
  });

  it("flags an elevated bounce rate on a recent send, amber", async () => {
    fake = world([post()], () => [send({ c_delivered: 90, c_bounced: 10 })]);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("amber")).toBe(true);
    expect(health.textContent).toMatch(/Elevated bounce rate \(10%\)/);
  });

  it("shows the first-run checklist when nothing is written and no one is on the list, and its New post creates one", async () => {
    fake = fakeApi([
      liveRoute(() => []),
      { path: "/posts", reply: () => ({ posts: [], page }) },
      { path: "/sends", reply: () => ({ sends: [], page }) },
      { path: "/subscribers", reply: () => ({ counts: none, subscribers: [], page }) },
      { method: "POST", path: "/posts", reply: () => ({ post: { id: "p9" }, revision_id: "r" }) },
    ]);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".setup-title").textContent).toBe("Set up your publication");
    expect(document.querySelector(".tiles")).toBeNull();
    expect($(".setup-url").textContent).toBe("https://app.birds.example/subscribe");
    expect($(".setup [data-nav='#/settings']").textContent).toBe("Settings");
    expect($(".pub-links a").textContent?.trim()).toBe("Connect Claude →");
    $(".setup [data-act='new-post']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe("{}");
    expect(location.hash).toBe("#/edit/p9");
  });

  it("opens the post from a draft row or a scheduled card, the record from a sent row, and the watch from the active card", async () => {
    const sends = [
      send(),
      send({ id: "x2", post_id: "p2", status: "scheduled", fire_at: NOW + 60_000 }),
      send({ id: "x3", post_id: "p4", status: "sending", c_pending: 50, c_accepted: 50 }),
    ];
    fake = world(
      [post()],
      () => sends,
      () => [liveSend(sends[2] as SendListItem, "progressing")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    $("tr[data-id='p1'] td:last-child").click();
    expect(location.hash).toBe("#/edit/p1");
    $("tr[data-send='x1'] td:nth-child(2)").click();
    expect(location.hash).toBe("#/sent/x1");
    $("#dashScheduled .sched-card .muted").click();
    expect(location.hash).toBe("#/edit/p2");
    $("#dashActive .active-card .active-stat").click();
    expect(location.hash).toBe("#/sent/x3");
  });

  it("moves a send that starts and finishes between two reads straight from the queue to the Sent table, within one read", async () => {
    let stage: "due" | "sent" = "due";
    const later = send({ id: "x2", post_id: "p2", status: "scheduled", fire_at: NOW + 60_000 });
    const fast = () =>
      stage === "due"
        ? send({
            id: "x3",
            post_id: "p4",
            subject: "Swifts",
            status: "scheduled",
            fire_at: NOW - 5_000,
            started_at: null,
            completed_at: null,
            c_delivered: 0,
            c_bounced: 0,
          })
        : send({
            id: "x3",
            post_id: "p4",
            subject: "Swifts",
            status: "sent",
            fire_at: NOW - 5_000,
            c_accepted: 50,
            c_delivered: 0,
            c_bounced: 0,
            completed_at: Date.now(),
          });
    fake = world(
      [post()],
      () => [later, fast()],
      () => [liveSend(fast(), stage === "due" ? "due" : "settling")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($$("#dashScheduled .sched-card").map((c) => c.dataset.post)).toEqual(["p4", "p2"]);
    expect($("#dashSent").textContent).toMatch(/No sends yet/);
    const listReads = () => fake.calls.filter((c) => c.url.pathname === "/sends").length;
    const before = listReads();
    await vi.advanceTimersByTimeAsync(3000); // due: the layer reads every 3 s
    expect(liveReads(fake)).toHaveLength(2);
    expect(listReads()).toBe(before); // nothing moved, nothing re-read
    // The tick starts it and it finishes dispatch before the next read: one change, due to sent.
    stage = "sent";
    await vi.advanceTimersByTimeAsync(3000);
    expect($$("#dashScheduled .sched-card").map((c) => c.dataset.post)).toEqual(["p2"]);
    const row = $("#dashSent tr[data-send='x3']");
    expect($(".badge", row).textContent).toBe("sent");
    expect($("a", row).getAttribute("href")).toBe("#/sent/x3");
    expect($$(".dash-head")).toHaveLength(1); // repainted in place, no full re-render
    expect(fake.unhandled).toEqual([]);
  });

  it("makes no request while nothing is due, sending, or settling, and wakes once when the next send comes due", async () => {
    const fire = NOW + 2 * 3_600_000;
    const scheduled = send({
      id: "x2",
      post_id: "p2",
      status: "scheduled",
      fire_at: fire,
      started_at: null,
    });
    fake = world(
      [post()],
      () => [scheduled],
      () => [],
      counts,
      () => fire,
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const calls = fake.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fake.calls.length).toBe(calls); // the countdown ticks with no network
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    expect(liveReads(fake)).toHaveLength(2); // the fire time: one read, to see it due
  });

  it("keeps a refused send's red line live, and clears it when the refusal lifts", async () => {
    let refused = false;
    const row = send({
      id: "x3",
      post_id: "p4",
      subject: "Swifts",
      status: "sending",
      c_pending: 50,
      c_accepted: 10,
      completed_at: null,
    });
    const halt = {
      reason: "account" as const,
      cause: "quota" as const,
      error: "ses 429 TooManyRequestsException: Daily message quota exceeded.",
      since: NOW,
      retry_at: NOW + 300_000,
    };
    fake = world(
      [post()],
      () => [row],
      () => [
        refused
          ? liveSend(row, "needs-attention", { attention: { refused: true }, halt })
          : liveSend(row, "progressing"),
      ],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashActive .active-card").dataset.watch).toBe("x3");
    refused = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".health.red").textContent).toMatch(/refusing this account, pausing Swifts: ses 429/);
    // The provider's words end in a period already: the line adds none of its own.
    expect($(".health.red").textContent).toMatch(/quota exceeded\. Wait for the provider's/);
    expect($(".health a").getAttribute("href")).toBe("#/sent/x3");
    expect(document.querySelector("#dashActive .active-card")).toBeNull(); // reported once
    await vi.advanceTimersByTimeAsync(9000);
    expect($(".health.red").textContent).toMatch(/Daily message quota/); // it stays
    refused = false; // the retry got through
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashActive .active-card").dataset.watch).toBe("x3");
  });

  it("keeps a wedged send's red line until Resolve lets it finish, then shows it sent", async () => {
    let resolved = false;
    const row = () =>
      resolved
        ? send({
            id: "w1",
            post_id: "p4",
            subject: "Kinglets",
            status: "sent",
            c_accepted: 99,
            c_in_flight: 0,
            c_unsent: 1,
            c_delivered: 0,
            c_bounced: 0,
          })
        : send({
            id: "w1",
            post_id: "p4",
            subject: "Kinglets",
            status: "sending",
            c_accepted: 99,
            c_in_flight: 1,
            c_delivered: 0,
            c_bounced: 0,
            completed_at: null,
          });
    fake = world(
      [post()],
      () => [row()],
      () => [
        resolved
          ? liveSend(row(), "settling")
          : liveSend(row(), "needs-attention", { attention: { wedged: true, wedged_count: 1 } }),
      ],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".health.red").textContent).toBe(
      "⚠️Kinglets has 1 ambiguous delivery awaiting a decision; resolve it on its page.",
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect($(".health.red a").getAttribute("href")).toBe("#/sent/w1");
    resolved = true; // Resolve, on the send's page
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashSent tr[data-send='w1'] .badge").textContent).toBe("sent");
  });

  it("follows a settling send's receipts in its Delivered cell, to the last one", async () => {
    let delivered = 10;
    let complete = false;
    const row = () =>
      send({
        id: "x1",
        status: "sent",
        completed_at: NOW - 10_000,
        c_accepted: 100 - delivered - (complete ? 2 : 0),
        c_delivered: delivered,
        c_bounced: complete ? 2 : 0,
      });
    fake = world(
      [post()],
      () => [row()],
      () => [liveSend(row(), complete ? "complete" : "settling")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const cell = () => $("#dashSent tr[data-send='x1'] td.delivered").textContent;
    expect(cell()).toBe("10");
    const listReads = () => fake.calls.filter((c) => c.url.pathname === "/sends").length;
    const before = listReads();
    delivered = 60;
    await vi.advanceTimersByTimeAsync(3000);
    expect(cell()).toBe("60");
    expect(listReads()).toBe(before); // the counts came with the layer's read
    delivered = 98;
    complete = true; // the last receipt: it leaves the live set, named as complete
    await vi.advanceTimersByTimeAsync(3000);
    expect(cell()).toBe("982 bounced");
    const reads = liveReads(fake).length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(liveReads(fake)).toHaveLength(reads); // nothing left to follow
  });

  it("keeps a sending send's Delivered in the Sent table in step with its active-send card", async () => {
    let confirmed = 0;
    const row = () =>
      send({
        id: "x3",
        subject: "Swifts",
        status: "sending",
        c_pending: 60,
        c_accepted: 40 - confirmed,
        c_delivered: confirmed,
        c_bounced: 0,
        completed_at: null,
      });
    fake = world(
      [post()],
      () => [row()],
      () => [liveSend(row(), "progressing")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("0");
    confirmed = 34;
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("34");
    expect($("#dashActive .active-stat").textContent).toMatch(/34 confirmed/);
  });

  it("stops reading when the reader navigates away", async () => {
    const row = send({ id: "x3", status: "sending", c_pending: 50 });
    fake = world(
      [post()],
      () => [row],
      () => [liveSend(row, "progressing")],
    );
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3000);
    expect(liveReads(fake)).toHaveLength(2);
    unmount(); // what navigating away does: the layer's follower leaves with the mount
    await vi.advanceTimersByTimeAsync(9000);
    expect(liveReads(fake)).toHaveLength(2);
  });

  it("paints one applied-change notice over the re-made scheduled sends, which a dismiss clears", async () => {
    const sends = [
      send({
        id: "x2",
        post_id: "p2",
        status: "scheduled",
        fire_at: NOW + 60_000,
        remade_at: NOW - 500,
      }),
      send({
        id: "x4",
        post_id: "p5",
        status: "scheduled",
        fire_at: NOW + 120_000,
        remade_at: NOW - 500,
      }),
      send({ id: "x5", post_id: "p6", status: "scheduled", fire_at: NOW + 180_000 }),
    ];
    fake = world([post()], () => sends);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const n = $("#dashNotices .notice");
    expect(n.dataset.notice).toBe("applied|*");
    expect(n.textContent).toMatch(/was applied to 2 scheduled posts\. Send a fresh test email/);
    $(".notice-dismiss", n).click();
    expect(document.querySelector("#dashNotices .notice")).toBeNull();
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector("#dashNotices .notice")).toBeNull(); // dismissed stays dismissed
  });

  it("quick actions: add a subscriber, edit the publication, copy an origin", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fake = world([post()], () => []);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    $(".quick-actions [data-act='add-sub']").click();
    expect($("#addEmail")).toBeTruthy();
    $("#aCancel").click();
    $(".quick-actions [data-nav]").click();
    expect(location.hash).toBe("#/settings");
    $(".pub-card [data-copy]").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(writeText).toHaveBeenCalledWith("https://app.birds.example");
    expect($("#toasts").textContent).toMatch(/Copied/);
    vi.unstubAllGlobals();
  });
});

describe("confirmUnsubscribe", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });
  const sub = {
    id: "s1",
    email: "a@b.c",
    status: "confirmed" as const,
    confirm_token: null,
    confirm_sent_at: 1,
    confirm_attempt_at: 1,
    unsub_token: "t",
    created_at: 1,
    confirmed_at: 2,
    unsubscribed_at: null,
  };

  it("names the address, unsubscribes on confirm, and tells the caller", async () => {
    fake = fakeApi([{ method: "POST", path: "/subscribers/s1/unsubscribe", reply: () => ({}) }]);
    const onDone = vi.fn();
    confirmUnsubscribe(sub, onDone);
    expect($(".modal strong").textContent).toBe("a@b.c");
    $("#uGo").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /subscribers/s1/unsubscribe",
    ]);
    expect(onDone).toHaveBeenCalledOnce();
    expect($("#toasts").textContent).toMatch(/Unsubscribed a@b\.c/);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("cancels without a call", () => {
    fake = fakeApi([]);
    const onDone = vi.fn();
    confirmUnsubscribe(sub, onDone);
    $("#uCancel").click();
    expect(document.querySelector(".modal")).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });
});
