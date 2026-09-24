import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSend, SendSummary } from "../../shared/sends";
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
} from "../test/support";
import { renderSent } from "./list";
import { activeRowHtml, deliveredCell, needsOperator, rowCounts } from "./progress";

const page = { total: 1, limit: 50, offset: 0, sort: "fire", dir: "desc" };
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
  const card = (s: LiveSend) => {
    const el = document.createElement("div");
    el.innerHTML = activeRowHtml(s).markup;
    return el;
  };

  it("reads the watch's numbers: accepted over the audience, and the server's time to finish while handing off", () => {
    const el = card(liveSend(sending, "progressing", { eta_ms: 90_000 }));
    expect($(".active-stat", el).textContent).toBe(
      "Sending — 60 of 150 accepted · 10 confirmed · ~2 min left",
    );
    expect($<HTMLElement>(".active-fill", el).style.width).toBe("40%");
    expect(el.querySelector(".active-stuck")).toBeNull();
  });

  it("gives no time to finish while the send is paused, and says when it has been in flight too long", () => {
    const el = card(
      liveSend(sending, "backing-off", { eta_ms: 90_000, attention: { stuck: true } }),
    );
    expect($(".active-stat", el).textContent).not.toMatch(/left/);
    expect($(".active-stuck", el).textContent).toBe(
      "In progress over 30 minutes; it may be retrying.",
    );
  });

  it("belongs to the attention block instead when the send needs the operator", () => {
    expect(needsOperator(liveSend(sending, "progressing"))).toBe(false);
    expect(
      needsOperator(liveSend(sending, "needs-attention", { attention: { wedged: true } })),
    ).toBe(true);
    expect(
      needsOperator(liveSend(sending, "needs-attention", { attention: { refused: true } })),
    ).toBe(true);
  });
});

/** The Worker's /sends, filtering on `status` over a scripted world. */
function sendsRoute(all: () => SendSummary[]) {
  return {
    path: "/sends",
    reply: (req: { url: URL }) => {
      const status = req.url.searchParams.get("status");
      const sends = all().filter((s) => !status || s.status === status);
      return { sends, page: { ...page, total: sends.length } };
    },
  };
}

describe("sent view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/sent";
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });

  it("renders the scheduled queue with a countdown, the in-flight card, and the sent table", async () => {
    const scheduled = send({
      id: "sch",
      status: "scheduled",
      fire_at: Date.now() + 2 * 3600_000,
      subject: "Waxwings",
      completed_at: null,
    });
    const sending = send({
      id: "act",
      status: "sending",
      c_accepted: 60,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      c_pending: 90,
      started_at: Date.now() - 60_000,
      completed_at: null,
      subject: "Live one",
    });
    fake = fakeApi([
      liveRoute(() => [liveSend(sending, "progressing")]),
      sendsRoute(() => [scheduled, sending, send()]),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".sched-card .sched-subj").textContent).toBe("Waxwings");
    expect($(".sched-card .countdown").textContent).toMatch(/Sends in 2h/);
    expect($(".active-card .active-subj").textContent).toBe("Live one");
    expect($(".active-card .active-stat").textContent).toMatch(/60 of 150 accepted/);
    expect($$("tr[data-id]")).toHaveLength(1);
    expect($("tr[data-id='x1'] .subject").textContent).toBe("Owls & co");
    expect($("tr[data-id='x1'] .delivered").textContent).toMatch(/147.*1 complained, 2 bounced/);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a refused send as one attention card with the provider's words, not as in progress", async () => {
    const refused = send({
      id: "ref",
      status: "sending",
      c_pending: 90,
      subject: "Paused one",
      halt_reason: "account",
      halt_cause: "suspended",
      halt_error: "ses 400 SendingPausedException: Account is paused",
      halted_at: Date.now() - 60_000,
      completed_at: null,
    });
    fake = fakeApi([
      liveRoute(() => [
        liveSend(refused, "needs-attention", {
          attention: { refused: true },
          halt: {
            reason: "account",
            cause: "suspended",
            error: "ses 400 SendingPausedException: Account is paused",
            since: Date.now() - 60_000,
            retry_at: Date.now() + 240_000,
          },
        }),
      ]),
      sendsRoute(() => [refused]),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    const cards = $$("#stuck .stuck-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Paused one");
    expect(cards[0]!.textContent).toContain("ses 400 SendingPausedException: Account is paused");
    expect(cards[0]!.textContent).toContain("in the SES console");
    expect(cards[0]!.querySelector("a")!.getAttribute("href")).toBe("#/sent/ref");
    expect(cards[0]!.querySelector("button")).toBeNull(); // nothing in the app to press
    expect(document.querySelector(".active-card")).toBeNull();
  });

  it("opens the record on a row click and the editor on a scheduled card click", async () => {
    const scheduled = send({ id: "sch", status: "scheduled", post_id: "p7", completed_at: null });
    fake = fakeApi([liveRoute(() => []), sendsRoute(() => [scheduled, send()])]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    $("tr[data-id='x1'] .delivered").click();
    expect(location.hash).toBe("#/sent/x1");
    $(".sched-card .muted").click();
    expect(location.hash).toBe("#/edit/p7");
  });

  it("cancels a scheduled send, refreshes its sections, and has the layer read at once", async () => {
    const scheduled = send({ id: "sch", status: "scheduled", completed_at: null });
    let canceled = false;
    fake = fakeApi([
      liveRoute(() => []),
      {
        method: "POST",
        path: "/sends/sch/cancel",
        reply: () => {
          canceled = true;
          return { send: { ...scheduled, status: "canceled" } };
        },
      },
      sendsRoute(() => (canceled ? [send()] : [scheduled, send()])),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect(liveReads(fake)).toHaveLength(1);
    $("[data-cancel='sch']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(canceled).toBe(true);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($("#toasts").textContent).toMatch(/Canceled/);
    expect(liveReads(fake)).toHaveLength(2);
  });

  it("moves a send that starts and finishes between two reads from the queue to the records, within one read", async () => {
    let sent = false;
    const row = () =>
      sent
        ? send({
            id: "fast",
            subject: "Swifts",
            status: "sent",
            fire_at: Date.now() - 5_000,
            completed_at: Date.now(),
            c_accepted: 150,
            c_delivered: 0,
            c_bounced: 0,
            c_complained: 0,
          })
        : send({
            id: "fast",
            subject: "Swifts",
            status: "scheduled",
            fire_at: Date.now() - 5_000,
            started_at: null,
            completed_at: null,
            c_delivered: 0,
            c_bounced: 0,
            c_complained: 0,
          });
    fake = fakeApi([
      liveRoute(() => [liveSend(row(), sent ? "settling" : "due")]),
      sendsRoute(() => [row(), send()]),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect($(".sched-card .sched-subj").textContent).toBe("Swifts");
    expect($$("tr[data-id]").map((tr) => tr.dataset.id)).toEqual(["x1"]);
    sent = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($$("tr[data-id]").map((tr) => tr.dataset.id)).toEqual(["fast", "x1"]);
    expect(document.querySelector(".active-card")).toBeNull(); // it never showed as in progress
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps a wedged send's attention card, with Resolve, until Resolve clears it", async () => {
    let resolved = false;
    const row = () =>
      resolved
        ? send({
            id: "wedge",
            subject: "Kinglets",
            status: "sent",
            c_accepted: 149,
            c_unsent: 1,
            c_delivered: 0,
            c_bounced: 0,
            c_complained: 0,
          })
        : send({
            id: "wedge",
            subject: "Kinglets",
            status: "sending",
            c_accepted: 149,
            c_in_flight: 1,
            c_delivered: 0,
            c_bounced: 0,
            c_complained: 0,
            completed_at: null,
          });
    fake = fakeApi([
      liveRoute(() => [
        resolved
          ? liveSend(row(), "settling")
          : liveSend(row(), "needs-attention", { attention: { wedged: true, wedged_count: 1 } }),
      ]),
      {
        method: "POST",
        path: "/sends/wedge/resolve",
        reply: () => {
          resolved = true;
          return { send: row(), resolved: 1, completed: true };
        },
      },
      sendsRoute(() => [row()]),
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
    expect($$("tr[data-id]").map((tr) => tr.dataset.id)).toEqual(["wedge"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("makes no request while nothing is due, sending, or settling", async () => {
    const later = send({
      id: "sch",
      status: "scheduled",
      fire_at: Date.now() + 3_600_000,
      completed_at: null,
    });
    fake = fakeApi([
      liveRoute(
        () => [],
        () => later.fire_at,
      ),
      sendsRoute(() => [later, send()]),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    const calls = fake.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fake.calls.length).toBe(calls);
  });

  it("says so in place when the first live read fails, and follows again on Retry", async () => {
    let down = true;
    fake = fakeApi([
      {
        path: "/sends/live",
        reply: () =>
          down
            ? new Response(JSON.stringify({ error: "internal_error" }), { status: 500 })
            : { now: Date.now(), sends: [], named: [], next_fire_at: null },
      },
      sendsRoute(() => [send()]),
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    expect($("#active").textContent).toMatch(/internal_error|Internal/i);
    expect($$("tr[data-id]")).toHaveLength(1); // the records stand on their own read
    down = false;
    $<HTMLButtonElement>("#active button").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($("#active").textContent).toBe("");
  });
});
