import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostListItem } from "../../shared/posts";
import type { SendSummary } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import type { SubscriberCounts } from "../../shared/subscribers";
import { appState } from "../state";
import { confirmUnsubscribe } from "../subscribers/dialogs";
import { $, $$, type FakeApi, fakeApi, mount, resetShell, unmount } from "../test/support";
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
const send = (over: Partial<SendSummary> = {}): SendSummary => ({
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
  remade_at: null,
  halt_reason: null,
  halt_cause: null,
  halt_error: null,
  halted_at: null,
  c_pending: 0,
  c_in_flight: 0,
  c_accepted: 0,
  c_delivered: 98,
  c_bounced: 2,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 0,
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

// A stateful fake: the sends list filters on `status` like the Worker does, so the poll and
// the queue refresh read the same world as the first render.
function world(posts: PostListItem[], sends: () => SendSummary[], subs = counts) {
  return fakeApi([
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

  it("raises the health line, red for a missed send and a wedged one, and keeps the wedged send out of the active widget", async () => {
    const sends = [
      send({ id: "m1", status: "scheduled", fire_at: NOW - 1_000, started_at: null }),
      send({ id: "w1", status: "sending", c_pending: 0, c_in_flight: 2, locked_until: null }),
      send({
        id: "st1",
        status: "sending",
        c_pending: 5,
        c_in_flight: 1,
        started_at: NOW - 11 * 60_000,
      }),
    ];
    fake = world([post()], () => sends);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    const lines = $$(":scope > div > div", health).map((d) => d.textContent);
    expect(lines).toEqual([
      "1 scheduled send passed the fire time without going out.",
      "2 ambiguous deliveries need a decision — resolve on the Sent page.",
      "A send has been in progress over 10 minutes — it may be retrying.",
    ]);
    expect($$("#dashActive .active-card").map((c) => c.dataset.watch)).toEqual(["st1"]);
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
    fake = world([post()], () => sends);
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
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe(`{"subject":"Untitled"}`);
    expect(location.hash).toBe("#/edit/p9");
  });

  it("opens the post from a draft row or a scheduled card, the record from a sent row, and the watch from the active card", async () => {
    const sends = [
      send(),
      send({ id: "x2", post_id: "p2", status: "scheduled", fire_at: NOW + 60_000 }),
      send({ id: "x3", post_id: "p4", status: "sending", c_pending: 50, c_accepted: 50 }),
    ];
    fake = world([post()], () => sends);
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

  it("keeps the active-send widget live: polls every 3 s, repaints in place, and refreshes the queue when the send finishes", async () => {
    let phase: "sending" | "sent" = "sending";
    const sends = () => [
      send({ id: "x2", post_id: "p2", status: "scheduled", fire_at: NOW + 60_000 }),
      send({
        id: "x3",
        post_id: "p4",
        status: phase,
        c_pending: phase === "sending" ? 50 : 0,
        c_accepted: 50,
        c_delivered: phase === "sending" ? 0 : 50,
      }),
    ];
    fake = world([post()], sends);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#dashActive .active-card").dataset.watch).toBe("x3");
    const polls = () =>
      fake.calls.filter((c) => c.url.searchParams.get("status") === "sending").length;
    const refreshes = () =>
      fake.calls.filter((c) => c.url.searchParams.get("status") === "scheduled").length;
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls()).toBe(1);
    expect($("#dashActive .active-card").dataset.watch).toBe("x3"); // still in flight
    const before = refreshes();
    phase = "sent";
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls()).toBe(2);
    expect(document.querySelector("#dashActive .active-card")).toBeNull(); // cleared in place
    expect(refreshes()).toBe(before + 1); // the transition refreshed the queue
    expect($("#dashScheduled .sched-card").dataset.post).toBe("p2");
    expect($$(".dash-head")).toHaveLength(1); // no full re-render
    expect(fake.unhandled).toEqual([]);
  });

  it("stops polling when the reader navigates away", async () => {
    fake = world([post()], () => [send({ id: "x3", status: "sending", c_pending: 50 })]);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const polls = () =>
      fake.calls.filter((c) => c.url.searchParams.get("status") === "sending").length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls()).toBe(1);
    unmount(); // what navigating away does: the armed tick is cleared with the mount
    await vi.advanceTimersByTimeAsync(9000);
    expect(polls()).toBe(1);
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
