import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendListItem, SendSummary } from "../../shared/sends";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  feedReads,
  listReads,
  mount,
  resetShell,
  sendServer,
} from "../test/support";
import { renderSent } from "./list";
import {
  activeRowHtml,
  countdownHtml,
  countdowns,
  deliveredCell,
  needsOperator,
  rowCounts,
  rowView,
  type SendView,
} from "./progress";

const send = (over: Partial<SendSummary> = {}): SendSummary => ({
  id: "x1",
  post_id: "p1",
  status: "sent",
  fire_at: 1_000_000,
  subject: "Owls & co",
  recipient_count: 150,
  locked_until: null,
  scheduled_at: 900_000,
  started_at: 1_000_000,
  completed_at: 1_001_000,
  audience_resolved_at: 1_000_000,
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
  c_delivered: 147,
  c_bounced: 2,
  c_complained: 1,
  c_skipped: 0,
  c_unsent: 0,
  rev: 1,
  ...over,
});

describe("deliveredCell", () => {
  it("reports webhook-confirmed delivered and names the failures worst first", () => {
    const m = deliveredCell(rowCounts(send())).markup;
    expect(m).toContain(`<span class="n">147</span>`);
    expect(m).toMatch(/1 complained.*2 bounced/);
    expect(deliveredCell(rowCounts(send({ c_bounced: 0, c_complained: 0 }))).markup).not.toContain(
      "delivered-note",
    );
  });
});

const item = (s: SendSummary, over: Partial<SendListItem> = {}): SendListItem => ({
  ...s,
  phase: "progressing",
  attention: { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: false },
  stuck: false,
  ...over,
});

describe("the in-progress card", () => {
  const sending = send({
    status: "sending",
    c_pending: 90,
    c_accepted: 50,
    c_delivered: 10,
    c_bounced: 0,
    c_complained: 0,
    completed_at: null,
  });
  const card = (s: SendView) => {
    const el = document.createElement("div");
    el.innerHTML = activeRowHtml(s).markup;
    return el;
  };
  const view = (over: Partial<SendListItem> = {}, eta_ms: number | null = null): SendView => ({
    ...rowView(item(sending, over)),
    dispatch: { eta_ms },
  });

  it("reads the watch's numbers: accepted over the audience, and the server's time to finish while handing off", () => {
    const el = card(view({}, 90_000));
    expect($(".active-stat", el).textContent).toBe(
      "Sending — 60 of 150 accepted · 10 confirmed · ~2 min left",
    );
    expect($<HTMLElement>(".active-fill", el).style.width).toBe("40%");
    expect(el.querySelector(".active-stuck")).toBeNull();
  });

  it("gives no time to finish while the send is paused, and says when it has been in flight too long", () => {
    const el = card(
      view(
        {
          phase: "backing-off",
          attention: { wedged: false, wedged_count: 0, stuck: true, missed: false, refused: false },
        },
        90_000,
      ),
    );
    expect($(".active-stat", el).textContent).not.toMatch(/left/);
    expect($(".active-stuck", el).textContent).toBe(
      "In progress over 30 minutes; it may be retrying.",
    );
  });

  it("belongs to the attention block instead when the send needs the operator", () => {
    const flags = { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: false };
    expect(needsOperator(view())).toBe(false);
    expect(needsOperator(view({ attention: { ...flags, wedged: true } }))).toBe(true);
    expect(needsOperator(view({ attention: { ...flags, refused: true } }))).toBe(true);
  });
});

describe("the scheduled card's countdown", () => {
  const NOW = 1_700_000_000_000;
  const row = (fire_at: number, over: Partial<SendListItem> = {}) =>
    item(send({ status: "scheduled", fire_at, started_at: null, completed_at: null }), {
      phase: "scheduled",
      ...over,
    });
  const words = (r: SendListItem) => {
    const el = document.createElement("div");
    el.innerHTML = countdownHtml(r).markup;
    const c = new AbortController();
    countdowns(el, c.signal)();
    c.abort();
    return el.querySelector("span")!;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("counts down to the fire time, then says Preparing to send, never Sending now", () => {
    expect(words(row(NOW + 90_000)).textContent).toBe("Sends in 1m 30s");
    expect(words(row(NOW + 2 * 3_600_000)).textContent).toBe("Sends in 2h");
    expect(words(row(NOW)).textContent).toBe("Preparing to send…");
    expect(words(row(NOW - 50_000, { phase: "due" })).textContent).toBe("Preparing to send…");
  });

  it("says Preparing to send when the server reads the send due, whatever the page's clock says", () => {
    expect(words(row(NOW + 4_000, { phase: "due" })).textContent).toBe("Preparing to send…");
  });

  it("says how late a send past the server's tolerance is, in the danger tone", () => {
    const missed = words(
      row(NOW - 12 * 60_000, {
        phase: "due",
        attention: { wedged: false, wedged_count: 0, stuck: false, missed: true, refused: false },
      }),
    );
    expect(missed.textContent).toBe("Missed its fire time · 12 min late");
    expect(missed.classList.contains("countdown-missed")).toBe(true);
    // Four minutes past with no flag from the server is still only preparing.
    const due = words(row(NOW - 4 * 60_000, { phase: "due" }));
    expect(due.textContent).toBe("Preparing to send…");
    expect(due.classList.contains("countdown-missed")).toBe(false);
  });

  it("ticks once a second for the life of the mount", () => {
    const el = document.createElement("div");
    el.innerHTML = countdownHtml(row(NOW + 3_000)).markup;
    const c = new AbortController();
    countdowns(el, c.signal);
    vi.advanceTimersByTime(1000);
    expect(el.textContent).toBe("Sends in 2s");
    vi.advanceTimersByTime(2000);
    expect(el.textContent).toBe("Preparing to send…");
    c.abort();
  });
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
    await vi.advanceTimersByTimeAsync(10);
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
    fake = world(sendServer([scheduled(), send()]));
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    const lists = listReads(fake);
    expect(lists.map((c) => c.url.searchParams.get("status"))).toEqual([
      "scheduled",
      "sending",
      "sent",
    ]);
    const [feed] = feedReads(fake);
    expect(feed?.url.searchParams.get("since")).toBeTruthy();
    for (const c of lists) {
      expect(fake.calls.indexOf(feed!)).toBeGreaterThan(fake.calls.indexOf(c));
    }
  });

  it("catches a change made between its own reads, following from the earliest of them", async () => {
    const srv = sendServer([scheduled(), send()]);
    const lists = srv.routes.find((r) => r.path === "/sends")!;
    fake = world(srv, [
      {
        path: "/sends",
        reply: (req) => {
          const out = lists.reply(req);
          if (req.url.searchParams.get("status") === "scheduled") {
            srv.edit("sch", { status: "canceled" }); // the other client, just after the queue's read
          }
          return out;
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    // The queue's read predates the cancel; the layer's first read reports it.
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
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(10);
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
        path: "/sends/sch/cancel",
        reply: () => {
          srv.edit("sch", { status: "canceled" });
          return {};
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect(feedReads(fake)).toHaveLength(1);
    $("[data-cancel='sch']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($("#toasts").textContent).toMatch(/Canceled/);
    expect(feedReads(fake)).toHaveLength(2);
  });

  it("shows the other client's cancel, move, and new schedule within one idle read", async () => {
    const srv = sendServer([scheduled(), send()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(10);
    const lists = listReads(fake).length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(feedReads(fake)).toHaveLength(31);
    expect(listReads(fake)).toHaveLength(lists);
  });

  it("says Preparing to send in the due minute, then hands the send to In progress on the read that sees it start", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 30_000 }), send()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect($(".sched-card .countdown").textContent).toBe("Preparing to send…");
    await vi.advanceTimersByTimeAsync(3_000); // the layer's read just past the fire time
    expect($(".sched-card .countdown").textContent).toBe("Preparing to send…");
    srv.edit("sch", { status: "sending", started_at: Date.now(), c_pending: 140, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($(".active-card .active-stat").textContent).toMatch(/^Sending — 10 of 150 accepted/);
    expect(document.body.textContent).not.toMatch(/Sending now/);
  });

  it("paints only the latest queue read, so a slow one never puts a started send back", async () => {
    const srv = sendServer([scheduled({ fire_at: NOW + 30_000 }), send()]);
    const lists = srv.routes.find((r) => r.path === "/sends")!;
    let hold: Promise<void> | null = null;
    let release = () => {};
    fake = world(srv, [
      {
        path: "/sends",
        reply: async (req) => {
          const out = lists.reply(req); // the world as it stands when the read arrives
          if (hold && req.url.searchParams.get("status") === "scheduled") {
            await hold;
          }
          return out;
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    hold = new Promise((r) => {
      release = r;
    });
    await vi.advanceTimersByTimeAsync(31_000); // the due read re-reads the queue: held
    hold = null;
    srv.edit("sch", { status: "sending", started_at: Date.now(), c_pending: 140, c_accepted: 10 });
    await vi.advanceTimersByTimeAsync(3_000); // the start: its queue read lands first
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    release(); // the older read, from before the start, lands last
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(10);
    const lists = listReads(fake).length;
    srv.edit("x1", { c_accepted: 0, c_delivered: 148, c_bounced: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("tr[data-id='x1'] .delivered").textContent).toBe("1482 bounced");
    expect(listReads(fake)).toHaveLength(lists);
  });

  it("keeps a wedged send's attention card, with Resolve, until Resolve clears it", async () => {
    const srv = sendServer();
    srv.put(
      sending({ id: "wedge", subject: "Kinglets", c_pending: 0, c_accepted: 149, c_in_flight: 1 }),
      {
        phase: "needs-attention",
        attention: { wedged: true, wedged_count: 1 },
      },
    );
    fake = world(srv, [
      {
        method: "POST",
        path: "/sends/wedge/resolve",
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
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(6000);
    const card = $("#stuck .stuck-card");
    expect(card.textContent).toMatch(/1 ambiguous delivery/);
    expect($("a", card).getAttribute("href")).toBe("#/sent/wedge");
    $<HTMLButtonElement>("[data-resolve='wedge']", card).click();
    $("#rUnsent").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector("#stuck .stuck-card")).toBeNull(); // at once, not at the next read
    expect(records()).toEqual(["wedge"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a quota halt live from the other client's write, and clears it when the retry gets through", async () => {
    const srv = sendServer([sending()]);
    fake = world(srv);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
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

  it("says so in place when the read of the sends in flight fails, and follows from its Retry", async () => {
    let down = true;
    const srv = sendServer([send()]);
    const lists = srv.routes.find((r) => r.path === "/sends")!;
    fake = world(srv, [
      {
        path: "/sends",
        reply: (req) =>
          down && req.url.searchParams.get("status") === "sending"
            ? new Response(JSON.stringify({ error: "internal_error" }), { status: 500 })
            : lists.reply(req),
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#active").textContent).toMatch(/internal_error|Internal/i);
    expect(records()).toHaveLength(1); // the records stand on their own read
    // A report from the layer (a receipt on the record) leaves the error and its Retry.
    srv.edit("x1", { c_delivered: 148 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("tr[data-id='x1'] .delivered .n").textContent).toBe("148");
    expect($("#active").textContent).toMatch(/internal_error|Internal/i);
    down = false;
    srv.put(sending());
    $<HTMLButtonElement>("#active button").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($(".active-card").dataset.watch).toBe("act");
  });
});
