import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostListItem } from "../../shared/posts";
import type { SendSummary } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import type { SubscriberCounts } from "../../shared/subscribers";
import { appState } from "../state";
import { confirmUnsubscribe } from "../subscribers/dialogs";
import {
  $,
  $$,
  condition,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  feedReads,
  listReads,
  mount,
  resetShell,
  sendServer,
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
  audience_resolved_at: NOW - 3_600_000,
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
  c_delivered: 98,
  c_bounced: 2,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 0,
  rev: 1,
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

// The dashboard's world: the posts and subscribers it reads once, and a stateful send server
// that answers the sends list and the layer's feed over one change sequence, so every read
// sees the same world and a spec's write is what any client's would be.
function world(
  posts: PostListItem[],
  srv: ReturnType<typeof sendServer>,
  subs = counts,
  extra: FakeRoute[] = [],
) {
  return fakeApi([
    ...extra,
    ...srv.routes,
    { path: "/posts", reply: () => ({ posts, page: { ...page, total: posts.length } }) },
    { path: "/subscribers", reply: () => ({ counts: subs, subscribers: [], page }) },
  ]);
}

const scheduled = (over: Partial<SendSummary> = {}) =>
  send({
    id: "x2",
    post_id: "p2",
    subject: "Gulls",
    status: "scheduled",
    fire_at: NOW + 60_000,
    started_at: null,
    completed_at: null,
    audience_resolved_at: null,
    c_delivered: 0,
    c_bounced: 0,
    recipient_count: 40,
    ...over,
  });
const sending = (over: Partial<SendSummary> = {}) =>
  send({
    id: "x3",
    post_id: "p4",
    subject: "Swifts",
    status: "sending",
    fire_at: NOW - 60_000,
    started_at: NOW - 60_000,
    completed_at: null,
    c_pending: 50,
    c_accepted: 10,
    c_delivered: 0,
    c_bounced: 0,
    ...over,
  });

const cards = () => $$("#dashScheduled .sched-card").map((c) => c.dataset.post);
const countdown = (post: string) => $(`#dashScheduled .sched-card[data-post='${post}'] .countdown`);

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
    const srv = sendServer([scheduled()]);
    srv.put(send(), { archive: "https://birds.example/archive/waxwings" });
    fake = world(posts, srv);
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
    fake = world([post({ author: "service" })], sendServer());
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

  it("follows from its own list read: the layer's first read asks from that read's cursor", async () => {
    fake = world([post()], sendServer([send()]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const [list] = listReads(fake);
    const [feed] = feedReads(fake);
    expect(listReads(fake)).toHaveLength(1);
    expect(feed?.url.searchParams.get("since")).toBeTruthy();
    // The feed's first read comes after the page's own, never beside it.
    expect(fake.calls.indexOf(feed!)).toBeGreaterThan(fake.calls.indexOf(list!));
  });

  it("raises the health line from the server's flags, red for a missed send and a wedged one, and keeps the wedged send out of the active widget", async () => {
    // The server decides every flag (SPEC §12): eleven minutes in is not in flight too long,
    // thirty-one is, and a send due six minutes ago is past the missed tolerance.
    const srv = sendServer([scheduled({ id: "m1", post_id: "p9", fire_at: NOW - 6 * 60_000 })]);
    srv.put(sending({ id: "w1", subject: "Kinglets", c_pending: 0, c_in_flight: 2 }), {
      phase: "needs-attention",
      conditions: [condition.wedged(2, "w1")],
    });
    srv.put(sending({ id: "ok1", c_pending: 5, started_at: NOW - 11 * 60_000 }));
    srv.put(sending({ id: "st1", c_pending: 5, c_in_flight: 1, started_at: NOW - 31 * 60_000 }), {
      conditions: [condition.stuck()],
    });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    const lines = $$(":scope > div > div", health).map((d) => d.textContent);
    expect(lines).toEqual([
      "1 scheduled send passed the fire time without going out.",
      "Kinglets has 2 ambiguous deliveries awaiting a decision; resolve them on its page.",
      "Swifts: Still sending 31 minutes after it started; it may be retrying.",
    ]);
    // The wedged line leads to where Resolve is: the send's own page.
    expect($("a", health).getAttribute("href")).toBe("#/sent/w1");
    expect(
      $$("#dashActive .active-card")
        .map((c) => c.dataset.watch)
        .sort(),
    ).toEqual(["ok1", "st1"]);
    expect($("[data-watch='st1'] .active-stuck").textContent).toMatch(
      /31 minutes after it started/,
    );
    // The missed send's own card says how late it is, in the danger tone.
    expect(countdown("p9").textContent).toBe("Missed its fire time · 6 min late");
    expect(countdown("p9").classList.contains("countdown-missed")).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("says Preparing to send from the fire time, calls a due send missed only past the server's tolerance, and then says how late it is", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 20_000 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(countdown("p2").textContent).toBe("Sends in 20s");
    // The clock switches the card at the fire time, before any read says so.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
    // Just past it the layer reads, sees the send due, and re-reads the queue: still preparing.
    const before = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listReads(fake).length).toBe(before + 1);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
    expect(document.querySelector(".health")).toBeNull(); // an ordinary slow tick is no miss
    // Nothing starts it: at the tolerance the feed reports the miss, with no write.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect($(".health.red").textContent).toMatch(/1 scheduled send passed the fire time/);
    expect(countdown("p2").textContent).toBe("Missed its fire time · 5 min late");
    expect(countdown("p2").classList.contains("countdown-missed")).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(countdown("p2").textContent).toBe("Missed its fire time · 7 min late");
  });

  it("says Preparing to send when the server reads the send due, even with the page's clock behind", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 20_000 })]);
    fake = world([post()], srv);
    vi.setSystemTime(NOW + 25_000); // the server's clock, past the fire time
    const route = srv.routes.find((r) => r.path === "/sends")!;
    const reply = route.reply;
    route.reply = (req) => {
      const out = reply(req);
      vi.setSystemTime(NOW); // the page's, behind it
      return out;
    };
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
  });

  it("hands a due send from the queue to the active-send card on the read that sees it start, never saying Sending now", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW - 10_000 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
    srv.edit("x2", { status: "sending", started_at: Date.now(), c_pending: 30, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cards()).toEqual([]);
    expect($("#dashActive .active-stat").textContent).toMatch(/^Sending — 10 of 40 accepted/);
    expect(document.body.textContent).not.toMatch(/Sending now/);
  });

  it("raises one red line with the provider's words for a refused account, and keeps the send out of the active widget", async () => {
    const refused = (id: string) =>
      sending({
        id,
        c_pending: 40,
        halt_reason: "account",
        halt_cause: "credentials",
        halt_error: "Resend 401 invalid_api_key: API key is invalid",
        halted_at: NOW - 60_000,
      });
    const srv = sendServer([refused("r1"), refused("r2")]);
    // Only unavailable, which retries on its own: still an ordinary in-progress send.
    srv.put(
      sending({
        id: "u1",
        c_pending: 5,
        halt_reason: "unavailable",
        halt_cause: "outage",
        halt_error: "503",
      }),
      { phase: "backing-off" },
    );
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    expect($$(":scope > div > div", health).map((d) => d.textContent)).toEqual([
      "2 sends: The provider is refusing the account: Resend 401 invalid_api_key: API key is invalid. Replace the provider's API key or credentials in the deployment's secrets. No one has been marked unsent, and the send resumes on its own at its next retry once the account is fixed.",
    ]);
    // Several refused sends link to the Sent page that lists them; one links to its watch.
    expect($("a", health).getAttribute("href")).toBe("#/sent");
    expect($$("#dashActive .active-card").map((c) => c.dataset.watch)).toEqual(["u1"]);
  });

  it("flags an elevated bounce rate on a recent send, amber", async () => {
    // The server reads the spike off the send (SPEC §8); the dashboard only shows it.
    const srv = sendServer();
    srv.put(send({ c_delivered: 90, c_bounced: 10 }), {
      conditions: [condition.bounceSpike(10, 0.1)],
    });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const health = $(".health");
    expect(health.classList.contains("amber")).toBe(true);
    expect(health.textContent).toMatch(/10 recipients bounced \(10%\)/);
    expect($("a", health).getAttribute("href")).toBe("#/sent/x1");
  });

  it("shows the first-run checklist when nothing is written and no one is on the list, and its New post creates one", async () => {
    fake = world([], sendServer(), none, [
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
    fake = world([post()], sendServer([send(), scheduled(), sending({ c_accepted: 50 })]));
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
    const srv = sendServer([
      scheduled(),
      scheduled({ id: "x3", post_id: "p4", subject: "Swifts", fire_at: NOW - 5_000 }),
    ]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(cards()).toEqual(["p4", "p2"]);
    expect($("#dashSent").textContent).toMatch(/No sends yet/);
    const before = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(3000); // due: the server asks for a read every 3 s
    expect(feedReads(fake)).toHaveLength(2);
    expect(listReads(fake).length).toBe(before); // nothing moved, nothing re-read
    // The tick starts it and it finishes dispatch before the next read: one change, due to sent.
    srv.edit("x3", { status: "sent", c_accepted: 50, completed_at: Date.now() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cards()).toEqual(["p2"]);
    const row = $("#dashSent tr[data-send='x3']");
    expect($(".badge", row).textContent).toBe("sent");
    expect($("a", row).getAttribute("href")).toBe("#/sent/x3");
    expect($$(".dash-head")).toHaveLength(1); // repainted in place, no full re-render
    expect(fake.unhandled).toEqual([]);
  });

  it("reads about once a minute while nothing moves, and once just past the next fire time", async () => {
    const fire = NOW + 2 * 3_600_000;
    fake = world([post()], sendServer([scheduled({ fire_at: fire })]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const lists = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(feedReads(fake)).toHaveLength(61); // the first, then one a minute
    expect(listReads(fake).length).toBe(lists); // nothing changed, nothing re-read
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    // The fire time: the read just past it sees the send due and re-reads the queue.
    expect(listReads(fake).length).toBe(lists + 1);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
  });

  it("shows the other client's cancel, move, new schedule, and re-make of far-off sends within one idle read", async () => {
    const far = NOW + 2 * 86_400_000;
    const srv = sendServer([
      scheduled({ fire_at: far }),
      scheduled({ id: "x5", post_id: "p5", subject: "Terns", fire_at: far + 3_600_000 }),
    ]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(cards()).toEqual(["p2", "p5"]);
    // Claude moves one a day later, which changes no stage.
    srv.edit("x5", { fire_at: NOW + 3 * 86_400_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(countdown("p5").textContent).toBe("Sends in 3 days");
    // Then cancels the other.
    srv.edit("x2", { status: "canceled" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cards()).toEqual(["p5"]);
    // Then schedules another, and a template change re-makes every scheduled send.
    srv.put(scheduled({ id: "x6", post_id: "p6", subject: "Rails", fire_at: far }));
    srv.edit("x5", { remade_at: Date.now() });
    srv.edit("x6", { remade_at: Date.now() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cards()).toEqual(["p6", "p5"]);
    expect($("#dashNotices .notice").textContent).toMatch(/was applied to 2 scheduled posts/);
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps a refused send's red line live, and clears it when the refusal lifts", async () => {
    const srv = sendServer([sending({ c_pending: 50 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashActive .active-card").dataset.watch).toBe("x3");
    srv.edit(
      "x3",
      {
        halt_reason: "account",
        halt_cause: "quota",
        halt_error: "ses 429 TooManyRequestsException: Daily message quota exceeded.",
        halted_at: Date.now(),
      },
      { phase: "needs-attention" },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".health.red").textContent).toMatch(
      /Swifts: The provider is refusing the account: ses 429/,
    );
    // The provider's words end in a period already: the line adds none of its own.
    expect($(".health.red").textContent).toMatch(/quota exceeded\. Wait for the provider's/);
    expect($(".health a").getAttribute("href")).toBe("#/sent/x3");
    expect(document.querySelector("#dashActive .active-card")).toBeNull(); // reported once
    await vi.advanceTimersByTimeAsync(9000);
    expect($(".health.red").textContent).toMatch(/Daily message quota/); // it stays
    // The retry got through.
    srv.edit("x3", { halt_reason: null, halt_cause: null, halt_error: null, halted_at: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashActive .active-card").dataset.watch).toBe("x3");
  });

  it("keeps a wedged send's red line until Resolve lets it finish, then shows it sent", async () => {
    const srv = sendServer();
    srv.put(sending({ id: "w1", subject: "Kinglets", c_accepted: 99, c_in_flight: 1 }), {
      phase: "needs-attention",
      conditions: [condition.wedged(1, "w1")],
    });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".health.red").textContent).toBe(
      "⚠️Kinglets has 1 ambiguous delivery awaiting a decision; resolve it on its page.",
    );
    // A wedged send moves only when someone resolves it: the layer reads at the idle pace,
    // not every few seconds, and the line stays.
    const reads = feedReads(fake).length;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(feedReads(fake).length - reads).toBeLessThanOrEqual(1);
    expect($(".health.red a").getAttribute("href")).toBe("#/sent/w1");
    // Resolve, on the send's page (another tab): shown within the minute.
    srv.edit("w1", { status: "sent", c_in_flight: 0, c_unsent: 1, completed_at: Date.now() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(document.querySelector(".health")).toBeNull();
    expect($("#dashSent tr[data-send='w1'] .badge").textContent).toBe("sent");
  });

  it("follows a settling send's receipts in its Delivered cell, to the last one", async () => {
    const srv = sendServer([
      send({ completed_at: NOW - 10_000, c_accepted: 90, c_delivered: 10, c_bounced: 0 }),
    ]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    const cell = () => $("#dashSent tr[data-send='x1'] td.delivered").textContent;
    expect(cell()).toBe("10");
    const before = listReads(fake).length;
    srv.edit("x1", { c_accepted: 40, c_delivered: 60 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cell()).toBe("60");
    expect(listReads(fake).length).toBe(before); // the counts came with the layer's read
    srv.edit("x1", { c_accepted: 0, c_delivered: 98, c_bounced: 2 }); // the last receipt
    await vi.advanceTimersByTimeAsync(3000);
    expect(cell()).toBe("982 bounced");
    // Complete: back to the idle pace, one read a minute.
    const reads = feedReads(fake).length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feedReads(fake).length - reads).toBeLessThanOrEqual(11);
    // A receipt long after dispatch still shows, within the minute.
    srv.edit("x1", { c_delivered: 97, c_bounced: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cell()).toBe("973 bounced");
  });

  it("keeps a sending send's Delivered in the Sent table in step with its active-send card", async () => {
    const srv = sendServer([sending({ c_pending: 60, c_accepted: 40 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("0");
    srv.edit("x3", { c_accepted: 6, c_delivered: 34 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("34");
    expect($("#dashActive .active-stat").textContent).toMatch(/34 confirmed/);
  });

  it("stops reading when the reader navigates away", async () => {
    fake = world([post()], sendServer([sending()]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3000);
    expect(feedReads(fake)).toHaveLength(2);
    unmount(); // what navigating away does: the layer's follower leaves with the mount
    await vi.advanceTimersByTimeAsync(9000);
    expect(feedReads(fake)).toHaveLength(2);
  });

  it("paints one applied-change notice over the re-made scheduled sends, which a dismiss clears", async () => {
    const srv = sendServer([
      scheduled({ remade_at: NOW - 500 }),
      scheduled({ id: "x4", post_id: "p5", fire_at: NOW + 120_000, remade_at: NOW - 500 }),
      scheduled({ id: "x5", post_id: "p6", fire_at: NOW + 180_000 }),
    ]);
    fake = world([post()], srv);
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
    fake = world([post()], sendServer());
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
