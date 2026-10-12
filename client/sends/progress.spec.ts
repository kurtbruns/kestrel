import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendSummary, SendView } from "../../shared/sends";
import { condition, sendView } from "../test/send_server";
import { $, sendSummary } from "../test/support";
import {
  activeRowHtml,
  can,
  clampPct,
  conditionOf,
  countdownHtml,
  countdowns,
  deliveredCell,
  fmtDuration,
  has,
  needsOperator,
  sendsNow,
} from "./progress";

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

const item = (s: SendSummary, over: Partial<SendView> = {}): SendView =>
  sendView(s, { phase: "progressing", ...over });

describe("clampPct / fmtDuration", () => {
  it("clamps and rounds; coarsens durations", () => {
    expect([clampPct(-5), clampPct(49.6), clampPct(120), clampPct(null)]).toEqual([0, 50, 100, 0]);
    expect([
      fmtDuration(45_000),
      fmtDuration(600_000),
      fmtDuration(7_200_000),
      fmtDuration(null),
    ]).toEqual(["45s", "10 min", "2 hr", "—"]);
  });
});

describe("has, conditionOf, and can", () => {
  const wedged = condition.wedged(2, "x1");
  const s = item(send({ status: "sending" }), {
    conditions: [condition.stuck(), wedged],
    actions: [{ name: "resolve", method: "POST", path: "/api/sends/x1/resolve" }],
  });

  it("read the server's conditions and actions on a send, and nothing else", () => {
    expect(has(s, "wedged")).toBe(true);
    expect(has(s, "stuck")).toBe(true);
    expect(has(s, "refused")).toBe(false);
    expect(conditionOf(s, "wedged")).toBe(wedged);
    expect(conditionOf(s, "wedged")?.count).toBe(2);
    expect(conditionOf(s, "missed")).toBeUndefined();
    expect(can(s, "resolve")).toBe(true);
    expect(can(s, "cancel")).toBe(false);
    // A send whose counters say wedged but whose server says nothing is not wedged here.
    expect(has(item(send({ status: "sending", c_in_flight: 3 })), "wedged")).toBe(false);
  });
});

describe("sendsNow", () => {
  const listed = [item(send({ id: "a" })), item(send({ id: "b" }))];

  it("keeps the page's rows in their order, each replaced by its latest report, then the sends it never read", () => {
    const b2 = item(send({ id: "b", subject: "Moved" }));
    const c = item(send({ id: "c" }));
    const now = sendsNow(
      listed,
      new Map([
        ["c", c],
        ["b", b2],
      ]),
    );
    expect(now.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(now[0]).toBe(listed[0]); // unreported: the row as read
    expect(now[1]).toBe(b2); // reported: the report, as it is
    expect(now[2]).toBe(c);
  });

  it("is the rows themselves when nothing was reported", () => {
    expect(sendsNow(listed, new Map())).toEqual(listed);
  });
});

describe("deliveredCell", () => {
  it("reports webhook-confirmed delivered and names the failures worst first", () => {
    const m = deliveredCell(sendView(send()).counts).markup;
    expect(m).toContain(`<span class="n">147</span>`);
    expect(m).toMatch(/1 complained.*2 bounced/);
    expect(
      deliveredCell(sendView(send({ c_bounced: 0, c_complained: 0 })).counts).markup,
    ).not.toContain("delivered-note");
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
  const card = (s: SendView) => {
    const el = document.createElement("div");
    el.innerHTML = activeRowHtml(s).markup;
    return el;
  };
  const view = (over: Partial<SendView> = {}, eta_ms: number | null = null): SendView => {
    const v = item(sending, over);
    return { ...v, dispatch: { ...v.dispatch, eta_ms } };
  };

  it("reads the watch's numbers: accepted over the audience, and the server's time to finish while handing off", () => {
    const el = card(view({}, 90_000));
    expect($(".active-stat", el).textContent).toBe(
      "Sending: 60 of 150 accepted · 10 confirmed · ~2 min left",
    );
    expect($<HTMLElement>(".active-fill", el).style.width).toBe("40%");
    expect(el.querySelector(".active-stuck")).toBeNull();
  });

  it("gives no time to finish when the server gives none (it gives none while paused), and says when it has been in flight too long", () => {
    const el = card(
      view(
        {
          phase: "backing-off",
          conditions: [condition.stuck()],
        },
        null,
      ),
    );
    expect($(".active-stat", el).textContent).not.toMatch(/left/);
    expect($(".active-stuck", el).textContent).toBe(
      "Still sending 31 minutes after it started; it may be retrying.",
    );
  });

  it("belongs to the attention block instead when the send needs the operator", () => {
    expect(needsOperator(view())).toBe(false);
    expect(needsOperator(view({ conditions: [condition.wedged(1)] }))).toBe(true);
    expect(needsOperator(view({ conditions: [condition.refused("no", null)] }))).toBe(true);
    expect(needsOperator(view({ conditions: [condition.stuck()] }))).toBe(false);
  });
});

describe("the scheduled card's countdown", () => {
  const NOW = 1_700_000_000_000;
  const row = (fire_at: number, over: Partial<SendView> = {}) =>
    item(send({ status: "scheduled", fire_at, started_at: null, completed_at: null }), {
      phase: "scheduled",
      ...over,
    });
  const words = (r: SendView) => {
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
        conditions: [
          {
            kind: "missed",
            severity: "action",
            since: NOW - 7 * 60_000,
            message: "The fire time passed and the send has not started.",
            action: null,
          },
        ],
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
    el.innerHTML = countdownHtml(row(NOW + 5_000)).markup;
    const c = new AbortController();
    countdowns(el, c.signal);
    vi.advanceTimersByTime(1000);
    expect(el.textContent).toBe("Sends in 4s");
    vi.advanceTimersByTime(2000);
    expect(el.textContent).toBe("Sends in 2s");
    // The mount ends mid-countdown: the cell stops where it was, and the fire time's own
    // tick never comes.
    c.abort();
    vi.advanceTimersByTime(5000);
    expect(el.textContent).toBe("Sends in 2s");
  });
});
