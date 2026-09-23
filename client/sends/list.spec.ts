import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendSummary } from "../../shared/sends";
import { $, $$, type FakeApi, fakeApi, mount, resetShell } from "../test/support";
import { renderSent } from "./list";
import { deliveredCell, isRefused, isWedged } from "./progress";

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
  ...over,
});

describe("deliveredCell / isWedged", () => {
  it("reports webhook-confirmed delivered and names the failures worst first", () => {
    const m = deliveredCell(send()).markup;
    expect(m).toContain(`<span class="n">147</span>`);
    expect(m).toMatch(/1 complained.*2 bounced/);
    expect(deliveredCell(send({ c_bounced: 0, c_complained: 0 })).markup).not.toContain(
      "delivered-note",
    );
  });

  it("is wedged only when sending, nothing pending, something in flight, and the lease released", () => {
    const wedged = send({ status: "sending", c_in_flight: 3, c_pending: 0, locked_until: null });
    expect(isWedged(wedged)).toBe(true);
    expect(isWedged({ ...wedged, locked_until: Date.now() + 60_000 })).toBe(false); // the loop is working it
    expect(isWedged({ ...wedged, c_pending: 5 })).toBe(false);
    expect(isWedged({ ...wedged, status: "sent" })).toBe(false);
  });
});

describe("isRefused", () => {
  it("is refused only while sending with an account-level halt", () => {
    const refused = send({ status: "sending", c_pending: 5, halt_reason: "account" });
    expect(isRefused(refused)).toBe(true);
    expect(isRefused({ ...refused, halt_reason: "unavailable" })).toBe(false);
    expect(isRefused({ ...refused, status: "sent" })).toBe(false);
  });
});

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
      subject: "Live one",
    });
    fake = fakeApi([
      {
        path: "/sends",
        reply: (req) => {
          const status = req.url.searchParams.get("status");
          const sends =
            status === "scheduled" ? [scheduled] : status === "sending" ? [sending] : [send()];
          return { sends, page: { ...page, total: sends.length } };
        },
      },
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
      {
        path: "/sends",
        reply: (req) => {
          const status = req.url.searchParams.get("status");
          const sends = status === "sending" ? [refused] : [];
          return { sends, page: { ...page, total: sends.length } };
        },
      },
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
    fake = fakeApi([
      {
        path: "/sends",
        reply: (req) => {
          const status = req.url.searchParams.get("status");
          const sends = status === "scheduled" ? [scheduled] : status === "sending" ? [] : [send()];
          return { sends, page: { ...page, total: sends.length } };
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    $("tr[data-id='x1'] .delivered").click();
    expect(location.hash).toBe("#/sent/x1");
    $(".sched-card .muted").click();
    expect(location.hash).toBe("#/edit/p7");
  });

  it("cancels a scheduled send and refreshes every section", async () => {
    const scheduled = send({ id: "sch", status: "scheduled", completed_at: null });
    let canceled = false;
    fake = fakeApi([
      {
        method: "POST",
        path: "/sends/sch/cancel",
        reply: () => {
          canceled = true;
          return { send: { ...scheduled, status: "canceled" } };
        },
      },
      {
        path: "/sends",
        reply: (req) => {
          const status = req.url.searchParams.get("status");
          const sends =
            status === "scheduled"
              ? canceled
                ? []
                : [scheduled]
              : status === "sending"
                ? []
                : [send()];
          return { sends, page: { ...page, total: sends.length } };
        },
      },
    ]);
    await mount(renderSent);
    await vi.advanceTimersByTimeAsync(10);
    $("[data-cancel='sch']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(canceled).toBe(true);
    expect($("#scheduled").textContent).toMatch(/Nothing scheduled/);
    expect($("#toasts").textContent).toMatch(/Canceled/);
  });
});
