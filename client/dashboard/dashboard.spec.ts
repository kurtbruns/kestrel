import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostListItem } from "../../shared/posts";
import type { SendSummary } from "../../shared/sends";
import type { SubscriberCounts } from "../../shared/subscribers";
import { appState } from "../state";
import { condition, feedReads, listReads, sendServer } from "../test/send_server";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  mount,
  resetShell,
  sendSummary,
  settingsResponse,
  stubClipboard,
  unmount,
} from "../test/support";
import { renderDashboard } from "./dashboard";

const NOW = 1_700_000_000_000;
const page = { total: 0, limit: 200, offset: 0, sort: "", dir: "desc" };

const post = (over: Partial<PostListItem> = {}): PostListItem => ({
  id: "p1",
  slug: "owls",
  slug_auto: true,
  unlisted_token: "t-p1",
  archive_url: "https://news.example.com/archive/owls",
  unlisted_url: "https://news.example.com/email/t-p1",
  published_at: null,
  archive_live: false,
  subject: "<b>Owls</b> & co",
  status: "draft",
  email_only: false,
  current_revision: "r1",
  created_at: NOW - 100_000,
  updated_at: NOW - 50_000,
  fire_at: null,
  active_send_id: null,
  active_send_status: null,
  author: "human",
  ...over,
});
// A send that went out an hour ago: 98 delivered, 2 bounced.
const send = (over: Partial<SendSummary> = {}): SendSummary =>
  sendSummary({
    post_id: "p3",
    status: "sent",
    fire_at: NOW - 3_600_000,
    subject: "Waxwings",
    recipient_count: 100,
    scheduled_at: NOW - 7_200_000,
    started_at: NOW - 3_600_000,
    completed_at: NOW - 3_500_000,
    audience_resolved_at: NOW - 3_600_000,
    c_delivered: 98,
    c_bounced: 2,
    ...over,
  });
const counts: SubscriberCounts = { pending: 3, confirmed: 40, unsubscribed: 2, suppressed: 1 };
const none: SubscriberCounts = { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 };

// What the dashboard reads from the boot-time settings: the identity and the origins.
const config = () =>
  settingsResponse({
    settings: {
      publication: { name: "Birds Weekly", tagline: "Owls & more", address: "", logoUrl: "" },
    },
    deployment: { archiveOrigin: "https://birds.example" },
  });

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
    { path: "/api/posts", reply: () => ({ posts, page: { ...page, total: posts.length } }) },
    { path: "/api/subscribers", reply: () => ({ counts: subs, subscribers: [], page }) },
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
    vi.unstubAllGlobals();
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
    await vi.advanceTimersByTimeAsync(0);
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
    // The publication card names only the home page: its address to copy, and the way out.
    expect($$(".pub-card [data-copy]").map((b) => b.dataset.copy)).toEqual([
      "https://app.birds.example",
    ]);
    expect($(".pub-card .pub-foot a").getAttribute("href")).toBe("/");
    // No service author yet: the guide leads, both links at one weight, each led by its glyph.
    expect($$(".pub-links a").map((a) => a.textContent?.trim())).toEqual([
      "Connect Claude →",
      "API reference →",
    ]);
    expect($$(".pub-links a svg").length).toBe(2);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the server's advice to move to Workers Paid by the subscriber count, and nothing without it (SPEC §7)", async () => {
    const advice =
      "This list has 1,200 confirmed subscribers, on the Workers Free plan’s limits. Workers Free suits a list of up to about 1,000 subscribers.";
    fake = world([post()], sendServer(), counts, [
      {
        path: "/api/subscribers",
        reply: () => ({ counts, subscribers: [], page, workers_plan_advice: advice }),
      },
    ]);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect($(".dash-section .tiles + #dashWorkersPlan").textContent).toBe(advice);
    fake.restore();
    fake = world([post()], sendServer());
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("#dashWorkersPlan")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("reports Claude as connected once the service principal has authored a revision", async () => {
    fake = world([post({ author: "service" })], sendServer());
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
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
    const srv = sendServer([send()]);
    // The clock stands still until the spec advances it, so this is the cursor the page's
    // own read is handed.
    const cursor = srv.cursor();
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const [list] = listReads(fake);
    const [feed] = feedReads(fake);
    expect(listReads(fake)).toHaveLength(1);
    expect(feed?.url.searchParams.get("since")).toBe(cursor);
    // The feed's first read comes after the page's own, never beside it.
    expect(fake.calls.indexOf(feed!)).toBeGreaterThan(fake.calls.indexOf(list!));
  });

  it("raises an amber line for a rate limit the deployment causes itself, and none for an ordinary outage (SPEC §12)", async () => {
    const srv = sendServer();
    srv.put(sending({ id: "t1", subject: "Terns", c_pending: 5 }), {
      phase: "backing-off",
      conditions: [condition.unavailable(true)],
    });
    srv.put(sending({ id: "o1", subject: "Owls", c_pending: 5 }), {
      phase: "backing-off",
      conditions: [condition.unavailable(false)],
    });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const health = $(".health");
    expect(health.classList.contains("amber")).toBe(true);
    expect($$(":scope > div > div", health).map((d) => d.textContent)).toEqual([
      "Terns: The provider keeps refusing for its sending rate: Maximum sending rate exceeded. Whoever runs the deployment sets SES_MAX_SEND_RATE.",
    ]);
    expect(fake.unhandled).toEqual([]);
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
    await vi.advanceTimersByTimeAsync(0);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    const lines = $$(":scope > div > div", health).map((d) => d.textContent);
    expect(lines).toEqual([
      "1 scheduled send passed the fire time without going out.",
      "Kinglets has 2 ambiguous deliveries awaiting a decision; resolve them on its page.",
      "Swifts: Nothing has gone out for 31 minutes, with no retry or provider problem to explain it.",
    ]);
    // The wedged line leads to where Resolve is: the send's own page.
    expect($("a", health).getAttribute("href")).toBe("#/sent/w1");
    expect(
      $$("#dashActive .active-card")
        .map((c) => c.dataset.watch)
        .sort(),
    ).toEqual(["ok1", "st1"]);
    // The health line says it is in flight too long, so its card doesn't say it again.
    expect(document.querySelector("[data-watch='st1'] .active-stuck")).toBeNull();
    // The missed send's own card says how late it is, in the danger tone.
    expect(countdown("p9").textContent).toBe("Missed its fire time · 6 min late");
    expect(countdown("p9").classList.contains("countdown-missed")).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("says Preparing to send from the fire time, calls a due send missed only past the server's tolerance, and then says how late it is", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 20_000 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
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
    srv.wrap("/api/sends", (req, reply) => {
      const out = reply(req);
      vi.setSystemTime(NOW); // the page's, behind it
      return out;
    });
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
  });

  it("hands a due send from the queue to the active-send card on the read that sees it start, never saying Sending now", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW - 10_000 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect(countdown("p2").textContent).toBe("Preparing to send…");
    srv.edit("x2", { status: "sending", started_at: Date.now(), c_pending: 30, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cards()).toEqual([]);
    expect($("#dashActive .active-stat").textContent).toMatch(/^Sending: 10 of 40 accepted/);
    expect(document.body.textContent).not.toMatch(/Sending now/);
  });

  it("raises one red line with the provider's words for a refused account, and keeps the send out of the active widget", async () => {
    const refused = (id: string) =>
      sending({
        id,
        c_pending: 40,
        halt_reason: "account",
        halt_cause: "credentials",
        halt_error:
          "ses 403 UnrecognizedClientException: The security token included in the request is invalid",
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
    await vi.advanceTimersByTimeAsync(0);
    const health = $(".health");
    expect(health.classList.contains("red")).toBe(true);
    expect($$(":scope > div > div", health).map((d) => d.textContent)).toEqual([
      "2 sends: The provider is refusing the account: ses 403 UnrecognizedClientException: The security token included in the request is invalid. Whoever runs the deployment replaces the SES access key in its secrets, or gives the key ses:SendEmail and ses:SendBulkEmail in its IAM policy. No one has been marked unsent because of this, and the send resumes on its own at its next retry once the account is fixed.",
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
    await vi.advanceTimersByTimeAsync(0);
    const health = $(".health");
    expect(health.classList.contains("amber")).toBe(true);
    expect(health.textContent).toMatch(/10 recipients bounced \(10%\)/);
    expect($("a", health).getAttribute("href")).toBe("#/sent/x1");
  });

  it("says, amber, when a recent send has heard no receipt long after it went out", async () => {
    // The server reads the silence off the send (SPEC §8); the dashboard only shows it, one
    // line however many sends it touches, since one broken event destination silences all.
    const srv = sendServer();
    srv.put(send({ c_delivered: 0, c_bounced: 0, c_accepted: 40 }), {
      conditions: [condition.noReceipts(40)],
    });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const health = $(".health");
    expect(health.classList.contains("amber")).toBe(true);
    expect(health.textContent).toMatch(/No delivery receipt has arrived for any of the 40/);
    expect($("a", health).getAttribute("href")).toBe("#/sent/x1");

    srv.put(send({ id: "x2", c_delivered: 0, c_bounced: 0, c_accepted: 9 }), {
      conditions: [condition.noReceipts(9)],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect($$(":scope > div > div", $(".health")).map((d) => d.textContent)).toEqual([
      "2 sends have had no delivery receipt long after they went out. The provider's events may not be reaching this app, so its bounces and complaints suppress no one.",
    ]);
    expect($("a", $(".health")).getAttribute("href")).toBe("#/sent");
  });

  it("shows the first-run checklist when nothing is written yet, and its New post creates one", async () => {
    fake = world([], sendServer(), none, [
      {
        method: "POST",
        path: "/api/posts",
        reply: () => ({ post: { id: "p9" }, revision_id: "r" }),
      },
    ]);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect($(".setup-title").textContent).toBe("Set up your publication");
    expect(document.querySelector(".tiles")).toBeNull();
    expect($(".setup-url").textContent).toBe("https://app.birds.example/subscribe");
    expect($(".setup [data-nav='#/settings']").textContent).toBe("Settings");
    expect($(".pub-links a").textContent?.trim()).toBe("Connect Claude →");
    $(".setup [data-act='new-post']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe("{}");
    expect(location.hash).toBe("#/edit/p9");
  });

  it("offers bringing an existing list before writing, as a step a fresh publication skips", async () => {
    fake = world([], sendServer(), none);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const step = $(".setup-list");
    expect(step.classList.contains("setup-done")).toBe(false);
    expect($("strong", step).textContent).toBe("Bring your existing list");
    expect($(".muted", step).textContent).toMatch(/Skip this if you’re starting fresh\.$/);
    expect($("button", step).dataset.nav).toBe("#/subscribers/import");
    expect($("button", step).textContent).toBe("Import");
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps the checklist after an import until the first post, with the list step done", async () => {
    // The first-run page ends at the first post, not the first subscriber, so the steps
    // after bringing a list in stay on screen.
    fake = world([], sendServer(), counts);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect($(".setup-title").textContent).toBe("Set up your publication");
    expect(document.querySelector(".tiles")).toBeNull();
    const step = $(".setup-list");
    expect(step.classList.contains("setup-done")).toBe(true);
    // Confirmed and pending: the people a send can reach once they confirm.
    expect($(".muted", step).textContent).toBe("43 subscribers on your list.");
    expect($("button", step).dataset.nav).toBe("#/subscribers");
    expect(document.querySelector(".setup [data-act='new-post']")).not.toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps offering the import while no one on the list can be sent to", async () => {
    // Only confirmed and pending subscribers count: an import that brought in only people
    // who left or bounced leaves the step open, since a send would reach no one.
    fake = world([], sendServer(), { pending: 0, confirmed: 0, unsubscribed: 12, suppressed: 3 });
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const step = $(".setup-list");
    expect(step.classList.contains("setup-done")).toBe(false);
    expect($("button", step).dataset.nav).toBe("#/subscribers/import");
    expect(fake.unhandled).toEqual([]);
  });

  // SPEC §9, DESIGN §4: a deployment with no provider connected says so where the
  // developer lands, as a standing state, and its checklist puts connecting one first.
  const steps = () => $$(".setup-steps li strong").map((s) => s.textContent);
  describe("while no email provider is connected", () => {
    const withProvider = (provider: "none" | "fake" | "ses") => {
      const c = config();
      c.deployment = { ...c.deployment, provider };
      appState.appConfig = c;
    };
    it("puts connecting one in place of the sending-domain step, ahead of writing, and keeps the subscribe link closed", async () => {
      withProvider("none");
      fake = world([], sendServer(), none);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect(steps()).toEqual([
        "Name your publication",
        "Connect Amazon SES",
        "Bring your existing list",
        "Publish your first post",
        "Share your subscribe link",
      ]);
      expect($(".setup-connect button").dataset.nav).toBe("#/docs/ses");
      expect($(".setup-connect button").textContent).toBe("Connect Amazon SES");
      expect($(".setup-subscribe").textContent).toMatch(
        /Signups open once an email provider is connected/,
      );
      expect(document.querySelector(".setup-url")).toBeNull();
      expect(document.querySelector(".setup-subscribe [data-copy]")).toBeNull();
      expect(fake.unhandled).toEqual([]);
    });

    it("raises an amber line in the health block on a populated dashboard, linking to connect one", async () => {
      withProvider("none");
      // A listed post has gone out, so setup is finished and the health block says it.
      fake = world([post()], sendServer([send()]), counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      // In the health block's own warning treatment (DESIGN §4), with nothing wrong on a send.
      const block = $("#dashHealth .health");
      expect(block.classList.contains("amber")).toBe(true);
      const line = $(".dash-not-connected", block);
      expect(line.textContent).toBe(
        "No email provider connected, so nothing can be sent yet. Connect Amazon SES to start sending.",
      );
      expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/ses");
      expect(line.querySelector("button")).toBeNull(); // a standing line: nothing to dismiss
      expect(fake.unhandled).toEqual([]);
    });

    it("says it once while setup is open: the Finish setting up card's Connect step, not a health line", async () => {
      withProvider("none");
      fake = world([post()], sendServer(), counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect($(".setup-card .setup-title").textContent).toBe("Finish setting up");
      expect($(".setup-card .setup-connect button").textContent).toBe("Connect Amazon SES");
      expect(document.querySelector("#dashHealth .health")).toBeNull();
      expect(fake.unhandled).toEqual([]);
    });

    it("says a scheduled send will be held, beside the countdown it keeps", async () => {
      withProvider("none");
      fake = world([post()], sendServer([scheduled()]), counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      const card = $("#dashScheduled .sched-card[data-post='p2']");
      expect(countdown("p2").textContent).toMatch(/^Sends in/);
      expect($(".sched-held", card).textContent).toBe(
        "Will be held: no email provider is connected.",
      );
      expect(fake.unhandled).toEqual([]);
    });

    // A held send is the deployment's state showing on a send: one line, not two.
    const held = (id: string, subject: string) =>
      sending({
        id,
        subject,
        c_pending: 40,
        halt_reason: "account",
        halt_cause: "not_connected",
        halt_error: "no email provider is connected",
        halted_at: NOW - 60_000,
      });
    it("says a held send and the state that holds it in one red line, the fix a link", async () => {
      withProvider("none");
      fake = world([post()], sendServer([held("h1", "Swifts")]), counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      const block = $("#dashHealth .health");
      expect(block.classList.contains("red")).toBe(true);
      expect($$(":scope > div > div", block).map((d) => d.textContent)).toEqual([
        "No email provider connected, so nothing can be sent and Swifts is held, with no one marked unsent; it goes out at its first retry once one is connected. Connect Amazon SES, then deploy.",
      ]);
      const links = $$<HTMLAnchorElement>("a", block).map((a) => a.getAttribute("href"));
      expect(links).toEqual(["#/sent/h1", "#/docs/ses"]);
      expect(fake.unhandled).toEqual([]);
    });

    it("counts several held sends, and in the local preview names the restart instead", async () => {
      withProvider("none");
      appState.appConfig!.deployment.notConnectedPreview = true; // SIMULATE_SENDS=not-connected
      fake = world([post()], sendServer([held("h1", "Swifts"), held("h2", "Terns")]), counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect($(".dash-not-connected").textContent).toBe(
        "No email provider connected, so nothing can be sent and 2 sends are held, with no one marked unsent; they go out at their first retry once one is connected. Restart npm run dev without SIMULATE_SENDS=not-connected to send.",
      );
      expect($("#dashHealth .health a").getAttribute("href")).toBe("#/sent");
      expect($$("#dashHealth .health > div > div")).toHaveLength(1);
      expect(fake.unhandled).toEqual([]);
    });

    it("shows neither once a provider is set, nor on local development's stand-in", async () => {
      for (const provider of ["ses", "fake"] as const) {
        withProvider(provider);
        fake = world([], sendServer(), none);
        await mount(renderDashboard);
        await vi.advanceTimersByTimeAsync(0);
        expect(steps(), provider).toEqual([
          "Name your publication",
          "Check your setup",
          "Bring your existing list",
          "Publish your first post",
          "Share your subscribe link",
        ]);
        expect($(".setup-url").textContent, provider).toBe("https://app.birds.example/subscribe");
        // Checking the setup is the publisher's step, so it opens the publisher's page.
        expect($(".setup-check button").dataset.nav, provider).toBe("#/docs/check-your-setup");
        unmount();
        fake.restore();
        fake = world([post()], sendServer([scheduled()]), counts);
        await mount(renderDashboard);
        await vi.advanceTimersByTimeAsync(0);
        expect(document.querySelector(".dash-not-connected"), provider).toBeNull();
        expect(document.querySelector(".sched-held"), provider).toBeNull();
        expect(document.querySelector("#dashHealth .health"), provider).toBeNull();
        unmount();
        fake.restore();
      }
    });
  });

  // DESIGN §3: setup's steps stay reachable after the first post, until a post listed in the
  // archive is published (SPEC §5).
  describe("Finish setting up", () => {
    const card = () => document.querySelector(".setup-card");
    const done = () => $$(".setup-card .setup-done strong").map((s) => s.textContent);

    it("carries the same steps as the first-run checklist once a draft exists, under the health block", async () => {
      fake = world([post()], sendServer(), none);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect($(".setup-card .setup-title").textContent).toBe("Finish setting up");
      expect($$(".setup-card .setup-steps li strong").map((s) => s.textContent)).toEqual([
        "Name your publication",
        "Check your setup",
        "Bring your existing list",
        "Publish your first post",
        "Share your subscribe link",
      ]);
      expect($("#dashSetup").previousElementSibling?.id).toBe("dashHealth");
      expect(document.querySelector(".tiles")).not.toBeNull(); // the regular dashboard
      // One Primary per view: the head's New post. The card's is Ghost.
      expect($$("button.primary[data-act='new-post']")).toHaveLength(1);
      expect(fake.unhandled).toEqual([]);
    });

    it("marks done only what the app knows: a name set, subscribers; never checking the setup, which is guidance", async () => {
      // A scheduled send and a sent email-only one: an operator's checks say nothing about
      // whether the publisher checked theirs, and neither is in the archive.
      const srv = sendServer([scheduled()]);
      srv.put(send(), { email_only: true });
      fake = world([post()], srv, counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect(done()).toEqual(["Name your publication", "Bring your existing list"]);
      expect($(".setup-card .setup-check button").textContent).toBe("Docs");
      // Every step but the archive one can be done, and the card still waits on it.
      expect($(".setup-card .setup-write button").textContent).toBe("New post");
      unmount();
      fake.restore();
      const c = config();
      c.settings.publication = { name: "", tagline: "", address: "", logoUrl: "" };
      appState.appConfig = c;
      fake = world([post()], sendServer(), none);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect(done()).toEqual([]);
      expect(fake.unhandled).toEqual([]);
    });

    it("stays while the only sends are email only, so Verify it works' test send doesn't end setup", async () => {
      const srv = sendServer();
      srv.put(send(), { email_only: true });
      fake = world([post({ status: "sent" })], srv, counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect(card()).not.toBeNull();
      expect(fake.unhandled).toEqual([]);
    });

    it("clears once a post listed in the archive has started sending, and doesn't come back on a later read", async () => {
      const srv = sendServer([scheduled({ fire_at: NOW + 30_000 })]);
      fake = world([post({ status: "scheduled" })], srv, counts);
      await mount(renderDashboard);
      await vi.advanceTimersByTimeAsync(0);
      expect(card()).not.toBeNull();
      // The sweep starts it: published, so the archive shows its first post.
      srv.edit("x2", { status: "sending", started_at: Date.now(), c_pending: 40 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(card()).toBeNull();
      expect(fake.unhandled).toEqual([]);
    });
  });

  it("marks an email-only post in the Sent table, and links its web version rather than the archive", async () => {
    const srv = sendServer();
    srv.put(send(), { email_only: true, archive: "https://birds.example/archive/waxwings" });
    srv.put(send({ id: "x4", post_id: "p5", subject: "Wrens" }));
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const quiet = $("tr[data-send='x1']");
    expect($(".email-only-mark", quiet).textContent?.trim()).toBe("Email only");
    expect($(".ghost-link", quiet).textContent).toBe("Web version\u00a0↗");
    const listed = $("tr[data-send='x4']");
    expect(listed.querySelector(".email-only-mark")).toBeNull();
    expect($(".ghost-link", listed).textContent).toBe("Archive\u00a0↗");
    expect(fake.unhandled).toEqual([]);
  });

  it("marks an email-only post's scheduled card, and only that one", async () => {
    const srv = sendServer();
    srv.put(scheduled(), { email_only: true });
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#dashScheduled .sched-card .sched-email-only").textContent).toBe("Email only");
    expect(fake.unhandled).toEqual([]);
  });

  it("marks an email-only draft beside its title, and only that one (DESIGN §2)", async () => {
    fake = world([post(), post({ id: "p2", subject: "Wrens", email_only: true })], sendServer());
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const label = (id: string) =>
      document.querySelector(`tr[data-id='${id}'] .email-only-mark`)?.textContent?.trim() ?? null;
    expect(label("p2")).toBe("Email only");
    expect(label("p1")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("opens the post from a draft row or a scheduled card, the record from a sent row, and the watch from the active card", async () => {
    fake = world([post()], sendServer([send(), scheduled(), sending({ c_accepted: 50 })]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
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
    // Off the minute grid, so only the read the server arms for just past the fire time can
    // see the send due: a read once a minute would land half a minute either side of it.
    const fire = NOW + 5 * 60_000 + 30_000;
    fake = world([post()], sendServer([scheduled({ fire_at: fire })]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const lists = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(feedReads(fake)).toHaveLength(6); // the first, then one a minute
    expect(listReads(fake)).toHaveLength(lists); // nothing changed, nothing re-read
    await vi.advanceTimersByTimeAsync(fire + 999 - Date.now());
    expect(feedReads(fake)).toHaveLength(6);
    expect(listReads(fake)).toHaveLength(lists);
    // A second past the fire time: that read sees the send due and re-reads the queue.
    await vi.advanceTimersByTimeAsync(1);
    expect(feedReads(fake)).toHaveLength(7);
    expect(listReads(fake)).toHaveLength(lists + 1);
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
    await vi.advanceTimersByTimeAsync(0);
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
    expect(
      $$("#dashScheduled .sched-remade-mark").map(
        (m) => m.closest<HTMLElement>(".sched-card")?.dataset.post,
      ),
    ).toEqual(["p6", "p5"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps a refused send's red line live, and clears it when the refusal lifts", async () => {
    const srv = sendServer([sending({ c_pending: 50 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
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
    expect($(".health.red").textContent).toMatch(/quota exceeded\. SES’s 24-hour quota/);
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
    await vi.advanceTimersByTimeAsync(0);
    expect($(".health.red").textContent).toBe(
      "⚠️Kinglets has 1 ambiguous delivery awaiting a decision; resolve it on its page.",
    );
    // A wedged send moves only when someone resolves it: the layer reads at the idle pace,
    // not every few seconds, and the line stays.
    const reads = feedReads(fake).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feedReads(fake).length - reads).toBe(1);
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
    await vi.advanceTimersByTimeAsync(0);
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
    expect(feedReads(fake).length - reads).toBe(10);
    // A receipt long after dispatch still shows, within the minute.
    srv.edit("x1", { c_delivered: 97, c_bounced: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cell()).toBe("973 bounced");
  });

  it("keeps a sending send's Delivered in the Sent table in step with its active-send card", async () => {
    const srv = sendServer([sending({ c_pending: 60, c_accepted: 40 })]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("0");
    srv.edit("x3", { c_accepted: 6, c_delivered: 34 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("34");
    expect($("#dashActive .active-stat").textContent).toMatch(/34 confirmed/);
  });

  it("reads the page again and follows from that read when its cursor is ahead of the database", async () => {
    const srv = sendServer([sending({ c_pending: 60, c_accepted: 40 })]);
    srv.aheadOnce(); // a local reset
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    expect(listReads(fake)).toHaveLength(2); // its own read, then again after the refusal
    expect(feedReads(fake)).toHaveLength(2); // refused, then from the fresh read
    expect($$(".dash-head")).toHaveLength(1);
    srv.edit("x3", { c_accepted: 6, c_delivered: 34 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#dashSent tr[data-send='x3'] td.delivered").textContent).toBe("34"); // following again
    expect(fake.unhandled).toEqual([]);
  });

  it("stops reading when the reader navigates away", async () => {
    fake = world([post()], sendServer([sending()]));
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(feedReads(fake)).toHaveLength(2);
    unmount(); // what navigating away does: the layer's follower leaves with the mount
    await vi.advanceTimersByTimeAsync(9000);
    expect(feedReads(fake)).toHaveLength(2);
  });

  it("marks each scheduled card the server reports as re-made since its last test, until a test lands (SPEC §8)", async () => {
    const srv = sendServer([
      scheduled({ remade_at: NOW - 500 }),
      scheduled({ id: "x4", post_id: "p5", fire_at: NOW + 120_000, remade_at: NOW - 500 }),
      scheduled({ id: "x5", post_id: "p6", fire_at: NOW + 180_000 }),
    ]);
    fake = world([post()], srv);
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    const marked = () =>
      $$("#dashScheduled .sched-remade-mark").map(
        (m) => m.closest<HTMLElement>(".sched-card")?.dataset.post,
      );
    expect(marked()).toEqual(["p2", "p5"]);
    expect($("#dashScheduled .sched-remade-mark").textContent).toBe(
      "Look changed since your last test",
    );
    srv.edit("x4", { tested_at: Date.now() }); // a test of the re-made copy, sent from the post
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marked()).toEqual(["p2"]);
  });

  it("quick actions: add a subscriber, edit the publication, copy an origin", async () => {
    const writeText = stubClipboard();
    fake = world([post()], sendServer());
    await mount(renderDashboard);
    await vi.advanceTimersByTimeAsync(0);
    $(".quick-actions [data-act='add-sub']").click();
    expect($("#addEmail")).toBeTruthy();
    $("#aCancel").click();
    $(".quick-actions [data-nav]").click();
    expect(location.hash).toBe("#/settings");
    $(".pub-card [data-copy]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("https://app.birds.example");
    // Said on the button, not in a toast.
    expect($(".pub-card [data-copy]").getAttribute("aria-label")).toBe("Copied");
    expect($("#toasts").textContent).toBe("");
  });
});
