import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendListResponse, SendSummary } from "../../shared/sends";
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
} from "../test/support";
import { toLocalInput } from "../ui/format";
import { renderSent } from "./list";

// A send that went out to 150: 147 delivered, 2 bounced, 1 complaint.
const send = (over: Partial<SendSummary> = {}): SendSummary =>
  sendSummary({
    status: "sent",
    fire_at: 1_000_000,
    subject: "Owls & co",
    recipient_count: 150,
    scheduled_at: 900_000,
    started_at: 1_000_000,
    completed_at: 1_001_000,
    audience_resolved_at: 1_000_000,
    c_delivered: 147,
    c_bounced: 2,
    c_complained: 1,
    ...over,
  });

describe("sent view", () => {
  const NOW = 1_700_000_000_000;
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    location.hash = "#/sent";
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });

  const world = (srv: ReturnType<typeof sendServer>, extra: FakeRoute[] = []) =>
    fakeApi([...extra, ...srv.routes]);
  const scheduled = (over: Partial<SendSummary> = {}) =>
    send({
      id: "sch",
      post_id: "p7",
      status: "scheduled",
      subject: "Waxwings",
      fire_at: NOW + 2 * 3_600_000,
      started_at: null,
      completed_at: null,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      ...over,
    });
  const sending = (over: Partial<SendSummary> = {}) =>
    send({
      id: "act",
      post_id: "p8",
      status: "sending",
      subject: "Live one",
      fire_at: NOW - 60_000,
      started_at: NOW - 60_000,
      completed_at: null,
      c_pending: 90,
      c_accepted: 60,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      ...over,
    });
  const queue = () => $$("#scheduled > .sched-card .sched-subj").map((a) => a.textContent);
  const records = () => $$("tr[data-id]").map((tr) => tr.dataset.id);

  it("renders the scheduled queue with a countdown, the in-flight card, and the sent table", async () => {
    fake = world(sendServer([scheduled(), sending(), send()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue()).toEqual(["Waxwings"]);
    expect($(".sched-card .countdown").textContent).toMatch(/Sends in 2h/);
    expect($(".active-card .active-subj").textContent).toBe("Live one");
    expect($(".active-card .active-stat").textContent).toMatch(/60 of 150 accepted/);
    expect(records()).toEqual(["x1"]);
    expect($("tr[data-id='x1'] .subject").textContent).toBe("Owls & co");
    expect($("tr[data-id='x1'] .delivered").textContent).toMatch(/147.*1 complained, 2 bounced/);
    expect(fake.unhandled).toEqual([]);
  });

  it("follows from its own reads: the layer's first read asks from the earliest of their cursors", async () => {
    const srv = sendServer([scheduled(), send()]);
    // The clock stands still until the spec advances it, so this is the cursor each of the
    // page's own reads is handed.
    const cursor = srv.cursor();
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const lists = listReads(fake);
    expect(lists.map((c) => c.url.searchParams.get("status"))).toEqual([
      "scheduled",
      "sending",
      "sent",
    ]);
    const [feed] = feedReads(fake);
    expect(feed?.url.searchParams.get("since")).toBe(cursor);
    for (const c of lists) {
      expect(fake.calls.indexOf(feed!)).toBeGreaterThan(fake.calls.indexOf(c));
    }
  });

  it("catches a change made between its own reads, following from the earliest of them", async () => {
    const srv = sendServer([scheduled(), send()]);
    const cursors: string[] = [];
    srv.wrap("/api/sends", (req, reply) => {
      const out = reply(req) as SendListResponse;
      cursors.push(out.cursor);
      if (req.url.searchParams.get("status") === "scheduled") {
        srv.edit("sch", { status: "canceled" }); // the other client, just after the queue's read
      }
      return out;
    });
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    // The queue's read predates the cancel; the layer's first read reports it.
    expect(new Set(cursors).size).toBe(2);
    expect(feedReads(fake)[0]?.url.searchParams.get("since")).toBe(cursors[0]);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
  });

  it("shows a refused send as one attention card with the provider's words, not as in progress", async () => {
    const srv = sendServer();
    srv.put(
      sending({
        id: "ref",
        subject: "Paused one",
        halt_reason: "account",
        halt_cause: "suspended",
        halt_error: "ses 400 SendingPausedException: Account is paused",
        halted_at: NOW - 60_000,
      }),
      { phase: "needs-attention" },
    );
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const cards = $$("#stuck .stuck-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Paused one");
    expect(cards[0]!.textContent).toContain("ses 400 SendingPausedException: Account is paused");
    expect(cards[0]!.textContent).toContain("in the SES console");
    // Words without a closing stop get one; the next sentence follows a single period.
    expect(cards[0]!.textContent).toContain("Account is paused. Settle the account's standing");
    expect(cards[0]!.querySelector("a")!.getAttribute("href")).toBe("#/sent/ref");
    expect(cards[0]!.querySelector("button")).toBeNull(); // nothing in the app to press
    expect(document.querySelector(".active-card")).toBeNull();
  });

  it("opens the record on a row click and the editor on a scheduled card click", async () => {
    fake = world(sendServer([scheduled(), send()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    $("tr[data-id='x1'] .delivered").click();
    expect(location.hash).toBe("#/sent/x1");
    $(".sched-card .muted").click();
    expect(location.hash).toBe("#/edit/p7");
  });

  it("cancels a scheduled send, refreshes its sections, and has the layer read at once", async () => {
    const srv = sendServer([scheduled(), send()]);
    fake = world(srv, [
      {
        method: "POST",
        path: "/api/sends/sch/cancel",
        reply: () => {
          srv.edit("sch", { status: "canceled" });
          return {};
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(feedReads(fake)).toHaveLength(1);
    $("[data-cancel='sch']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($("#toasts").textContent).toMatch(/Canceled/);
    expect(feedReads(fake)).toHaveLength(2);
  });

  it("reschedules a scheduled send from its card, refreshes the queue, and has the layer read at once", async () => {
    const srv = sendServer([scheduled(), send()]);
    fake = world(srv, [
      {
        method: "POST",
        path: "/api/sends/sch/reschedule",
        reply: (req) => {
          srv.edit("sch", {
            fire_at: new Date((req.json() as { fire_at: string }).fire_at).getTime(),
          });
          return {};
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(feedReads(fake)).toHaveLength(1);
    $("[data-reschedule='sch']").click();
    const when = $<HTMLInputElement>("#rsWhen");
    expect(when.value).toBe(toLocalInput(new Date(NOW + 2 * 3_600_000))); // opens at its time
    const moved = new Date(NOW + 3 * 86_400_000);
    when.value = toLocalInput(moved);
    $("#rsGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const posted = fake.calls.find((c) => c.url.pathname === "/api/sends/sch/reschedule");
    expect(posted?.json()).toEqual({ fire_at: new Date(toLocalInput(moved)).toISOString() });
    expect(document.querySelector(".modal")).toBeNull();
    expect($("#toasts").textContent).toMatch(/Rescheduled/);
    expect($(".sched-card .countdown").textContent).toBe("Sends in 3 days");
    expect(feedReads(fake)).toHaveLength(2);
    expect(fake.unhandled).toEqual([]);
  });

  // SPEC §9, DESIGN §4: a deployment with no provider says so in the health block's warning
  // treatment, and a send scheduled before stays movable, with a line saying it is held.
  it("warns that nothing can be sent while no provider is connected, and says a moved send is held", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    fake = world(sendServer([scheduled()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const warning = $(".sent-not-connected");
    expect(warning.classList.contains("health")).toBe(true);
    expect(warning.classList.contains("amber")).toBe(true);
    expect(warning.textContent?.replace("⚠️", "")).toBe(
      "No email provider connected, so nothing can be sent yet. Connect an email provider to start sending.",
    );
    expect($<HTMLAnchorElement>("a", warning).getAttribute("href")).toBe("#/docs/resend");
    $("[data-reschedule='sch']").click();
    expect($(".modal .not-connected").textContent).toBe(
      "No email provider connected, so this send is held when it fires, until one is. Connect an email provider to send it.",
    );
    expect($<HTMLButtonElement>("#rsGo").disabled).toBe(false); // the server still takes a move
    expect(fake.unhandled).toEqual([]);
  });

  // A held send is the not-connected state showing on a send: one card, not the amber line
  // and the send's own card, with the fix a link (or, in the local preview, the restart).
  const held = (id: string, subject: string) =>
    sending({
      id,
      subject,
      halt_reason: "account",
      halt_cause: "not_connected",
      halt_error: "No email provider is connected to this deployment.",
    });
  it("says held sends and the state that holds them once, with the fix a link", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    fake = world(sendServer([held("h1", "Swifts")]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLElement>(".sent-not-connected").hidden).toBe(true);
    const cards = $$("#stuck .stuck-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent?.replace("⚠️", "")).toBe(
      "No email provider connected, so nothing can be sent and Swifts is held, with no one marked unsent; it goes out at its first retry once one is connected. Connect an email provider, then deploy.",
    );
    expect($$<HTMLAnchorElement>("a", cards[0]!).map((a) => a.getAttribute("href"))).toEqual([
      "#/sent/h1",
      "#/docs/resend",
    ]);
    expect(fake.unhandled).toEqual([]);
  });

  it("names every held send, and in the local preview the restart", async () => {
    appState.appConfig = settingsResponse({
      deployment: { provider: "none", notConnectedPreview: true },
    });
    fake = world(sendServer([held("h1", "Swifts"), held("h2", "Terns"), held("h3", "Gulls")]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const cards = $$("#stuck .stuck-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent?.replace("⚠️", "")).toMatch(
      /and (Swifts|Terns|Gulls), (Swifts|Terns|Gulls) and (Swifts|Terns|Gulls) are held, with no one marked unsent; they go out at their first retry once one is connected\. Restart npm run dev without SIMULATE_SENDS=not-connected to send\.$/,
    );
    expect($$("a", cards[0]!)).toHaveLength(3);
    expect(fake.unhandled).toEqual([]);
  });

  it("says nothing of a provider once one is set", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "resend" } });
    fake = world(sendServer([scheduled()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".sent-not-connected")).toBeNull();
    $("[data-reschedule='sch']").click();
    expect(document.querySelector(".modal .not-connected")).toBeNull();
  });

  it("offers a scheduled card's Cancel and Reschedule only while the server would take them, hiding them at the fire time", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 5_000 })]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const controls = () => $<HTMLElement>("#scheduled [data-closes]");
    expect(controls().hidden).toBe(false);
    expect($("[data-cancel='sch']").textContent).toBe("Cancel");
    // The fire time passes: the window has closed, and the card hides them by the clock,
    // before the layer's read for the fire time.
    await vi.advanceTimersByTimeAsync(5_500);
    expect(controls().hidden).toBe(true);
    // That read sees the send due and re-reads the queue: a due send carries no window
    // actions, so its card offers none.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.querySelector("#scheduled [data-cancel]")).toBeNull();
    expect(document.querySelector("#scheduled [data-reschedule]")).toBeNull();
  });

  it("switches a scheduled card at the fire time itself, on the page's clock, with no read", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 5_500 })]);
    fake = world(srv);
    await mount(renderSent);
    // The once-a-second ticks fall on whole seconds from the mount, so the fire time sits
    // half a second between two of them: only a switch at the moment itself passes.
    await vi.advanceTimersByTimeAsync(0);
    const calls = fake.calls.length;
    const controls = () => $<HTMLElement>("#scheduled [data-closes]");
    await vi.advanceTimersByTimeAsync(5_499);
    expect(controls().hidden).toBe(false);
    expect($(".sched-card .countdown").textContent).toBe("Sends in 0s");
    await vi.advanceTimersByTimeAsync(1);
    expect(controls().hidden).toBe(true);
    expect($(".sched-card .countdown").textContent).toBe("Preparing to send…");
    expect(fake.calls).toHaveLength(calls);
  });

  it("shows the other client's cancel, move, and new schedule within one idle read", async () => {
    const srv = sendServer([scheduled(), send()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue()).toEqual(["Waxwings"]);
    srv.edit("sch", { fire_at: NOW + 3 * 86_400_000 }); // Claude moves it out
    srv.put(scheduled({ id: "s2", post_id: "p9", subject: "Rails", fire_at: NOW + 86_400_000 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue()).toEqual(["Rails"]); // the soonest leads; the other is behind Show all
    expect($("#schedToggle").textContent).toBe("Show all 2 scheduled");
    srv.edit("s2", { status: "canceled" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue()).toEqual(["Waxwings"]);
    expect($(".sched-card .countdown").textContent).toMatch(/Sends in 3 days/);
    expect(fake.unhandled).toEqual([]);
  });

  it("reads about once a minute while nothing moves, and re-reads nothing while nothing changes", async () => {
    fake = world(sendServer([scheduled({ fire_at: NOW + 3_600_000 }), send()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const lists = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(feedReads(fake)).toHaveLength(6); // the first, then one a minute
    expect(listReads(fake)).toHaveLength(lists);
  });

  it("says Preparing to send in the due minute, then hands the send to In progress on the read that sees it start", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 30_000 }), send()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect($(".sched-card .countdown").textContent).toBe("Preparing to send…");
    await vi.advanceTimersByTimeAsync(3_000); // the layer's read just past the fire time
    expect($(".sched-card .countdown").textContent).toBe("Preparing to send…");
    srv.edit("sch", { status: "sending", started_at: Date.now(), c_pending: 140, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($(".active-card .active-stat").textContent).toMatch(/^Sending: 10 of 150 accepted/);
    expect(document.body.textContent).not.toMatch(/Sending now/);
  });

  it("paints only the latest queue read, so a slow one never puts a started send back", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 30_000 }), send()]);
    let hold: Promise<void> | null = null;
    let release = () => {};
    srv.wrap("/api/sends", async (req, reply) => {
      const out = reply(req); // the world as it stands when the read arrives
      if (hold && req.url.searchParams.get("status") === "scheduled") {
        await hold;
      }
      return out;
    });
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    hold = new Promise((r) => {
      release = r;
    });
    await vi.advanceTimersByTimeAsync(31_000); // the due read re-reads the queue: held
    hold = null;
    srv.edit("sch", { status: "sending", started_at: Date.now(), c_pending: 140, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3_000); // the start: its queue read lands first
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    release(); // the older read, from before the start, lands last
    await vi.advanceTimersByTimeAsync(0);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($(".active-card").dataset.watch).toBe("sch");
  });

  it("moves a send that starts and finishes between two reads from the queue to the records, within one read", async () => {
    const srv = sendServer([
      scheduled({ id: "fast", subject: "Swifts", fire_at: NOW - 5_000 }),
      send(),
    ]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue()).toEqual(["Swifts"]);
    expect(records()).toEqual(["x1"]);
    srv.edit("fast", { status: "sent", completed_at: Date.now(), c_accepted: 150 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect(records()).toEqual(["fast", "x1"]);
    expect(document.querySelector(".active-card")).toBeNull(); // it never showed as in progress
    expect(fake.unhandled).toEqual([]);
  });

  it("follows a sent send's receipts in its Delivered cell without reading the records again", async () => {
    const srv = sendServer([
      send({ c_accepted: 50, c_delivered: 100, c_bounced: 0, c_complained: 0 }),
    ]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    const lists = listReads(fake).length;
    srv.edit("x1", { c_accepted: 0, c_delivered: 148, c_bounced: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("tr[data-id='x1'] .delivered .n").textContent).toBe("148");
    expect($("tr[data-id='x1'] .delivered-note").textContent).toBe("2 bounced");
    expect(listReads(fake)).toHaveLength(lists);
  });

  it("keeps a wedged send's attention card, with Resolve, until Resolve clears it", async () => {
    const srv = sendServer();
    srv.put(
      sending({ id: "wedge", subject: "Kinglets", c_pending: 0, c_accepted: 149, c_in_flight: 1 }),
      {
        phase: "needs-attention",
        conditions: [condition.wedged(1, "wedge")],
      },
    );
    fake = world(srv, [
      {
        method: "POST",
        path: "/api/sends/wedge/resolve",
        reply: () => {
          srv.edit("wedge", {
            status: "sent",
            c_in_flight: 0,
            c_unsent: 1,
            completed_at: Date.now(),
          });
          return { resolved: 1, completed: true };
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6000);
    const card = $("#stuck .stuck-card");
    expect(card.textContent).toMatch(/never answered for 1 recipient/);
    expect($("a", card).getAttribute("href")).toBe("#/sent/wedge");
    $<HTMLButtonElement>("[data-resolve='wedge']", card).click();
    $("#rUnsent").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("#stuck .stuck-card")).toBeNull(); // at once, not at the next read
    expect(records()).toEqual(["wedge"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a quota halt live from the other client's write, and clears it when the retry gets through", async () => {
    const srv = sendServer([sending()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect($(".active-card").dataset.watch).toBe("act");
    srv.edit(
      "act",
      { halt_reason: "account", halt_cause: "quota", halt_error: "Daily quota exceeded." },
      { phase: "needs-attention" },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#stuck .stuck-card").textContent).toMatch(/Daily quota exceeded\. Wait for/);
    expect(document.querySelector(".active-card")).toBeNull();
    srv.edit("act", { halt_reason: null, halt_cause: null, halt_error: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector("#stuck .stuck-card")).toBeNull();
    expect($(".active-card").dataset.watch).toBe("act");
  });

  it("reads the page again and follows from those reads when its cursor is ahead of the database", async () => {
    const srv = sendServer([
      send({ c_accepted: 50, c_delivered: 100, c_bounced: 0, c_complained: 0 }),
    ]);
    srv.aheadOnce(); // a local reset
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect(listReads(fake)).toHaveLength(6); // its three reads, then all three again
    expect(feedReads(fake)).toHaveLength(2); // refused, then from the fresh reads
    srv.edit("x1", { c_accepted: 0, c_delivered: 148, c_bounced: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    // Following again: the receipts reach the Delivered cell.
    expect($("tr[data-id='x1'] .delivered .n").textContent).toBe("148");
    expect($("tr[data-id='x1'] .delivered-note").textContent).toBe("2 bounced");
    expect(fake.unhandled).toEqual([]);
  });

  it("says so in place when the read of the sends in flight fails, and follows from its Retry", async () => {
    let down = true;
    const srv = sendServer([send()]);
    srv.wrap("/api/sends", (req, reply) =>
      down && req.url.searchParams.get("status") === "sending"
        ? new Response(JSON.stringify({ error: "internal_error" }), { status: 500 })
        : reply(req),
    );
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#active").textContent).toMatch(/went wrong on the server/);
    expect(records()).toHaveLength(1); // the records stand on their own read
    // A report from the layer (a receipt on the record) leaves the error and its Retry.
    srv.edit("x1", { c_delivered: 148 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("tr[data-id='x1'] .delivered .n").textContent).toBe("148");
    expect($("#active").textContent).toMatch(/went wrong on the server/);
    down = false;
    srv.put(sending());
    $<HTMLButtonElement>("#active button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".active-card").dataset.watch).toBe("act");
  });
});
