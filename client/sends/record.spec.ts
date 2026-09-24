import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryOutcomes, Send, SendProgress } from "../../shared/sends";
import {
  $,
  $$,
  condition,
  type FakeApi,
  fakeApi,
  mount,
  resetShell,
  typeInto,
  unmount,
} from "../test/support";
import { clampPct, fmtDuration } from "./progress";
import { renderSentRecord } from "./record";

const send = (over: Partial<Send> = {}): Send => ({
  id: "x1",
  post_id: "p1",
  status: "sent",
  fire_at: 1_000_000,
  rendered_html: "",
  rendered_text: "",
  subject: "Owls",
  recipient_count: 10,
  locked_until: null,
  scheduled_at: 900_000,
  started_at: 1_000_000,
  completed_at: 1_001_000,
  audience_resolved_at: 1_000_000,
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
  c_delivered: 8,
  c_bounced: 1,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 1,
  rev: 1,
  ...over,
});
const outcomes = (over: Partial<DeliveryOutcomes> = {}): DeliveryOutcomes => ({
  recipients: 10,
  delivered: 8,
  bounced: 1,
  complained: 0,
  unsent: 1,
  skipped: 0,
  accepted: 0,
  in_flight: 0,
  ...over,
});
const progress = (over: Partial<SendProgress> = {}): SendProgress => ({
  state: "sending",
  phase: "progressing",
  total: 10,
  counts: {
    pending: 4,
    in_flight: 1,
    accepted: 5,
    delivered: 0,
    bounced: 0,
    complained: 0,
    skipped: 0,
    unsent: 0,
  },
  dispatch: { done: 5, percent: 50, rate_per_min: 30, eta_ms: 10_000 },
  delivery: { confirmed: 0, percent_of_accepted: 0 },
  provider: { name: "fake", halt: null },
  conditions: [],
  actions: [],
  next_change_at: null,
  ...over,
});
const page = { total: 2, limit: 50, offset: 0, sort: "email", dir: "asc" };
const rows = [
  {
    email: "b@x.y",
    status: "accepted",
    event: "bounced",
    event_detail: "550",
    event_at: 1_000_500,
    error: null,
    attempts: 1,
    bounce_kind: "hard",
  },
  {
    email: "u@x.y",
    status: "unsent",
    event: null,
    event_detail: null,
    event_at: null,
    error: "timeout",
    attempts: 3,
    bounce_kind: null,
  },
];

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

describe("sent record", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/sent/x1";
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
  });

  it("renders the frozen record: tiles, the reconciliation line, and the failures list first", async () => {
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send(),
          progress: progress({ state: "sent", phase: "complete" }),
          outcomes: outcomes(),
          slug: "owls",
          archive_url: "http://a/archive/owls",
          published: true,
        }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: (req) => ({
          deliveries: req.url.searchParams.get("view") === "failures" ? rows : [],
          view: req.url.searchParams.get("view"),
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($("h1").textContent).toBe("Owls");
    expect($$(".rec-tile")).toHaveLength(5);
    expect($(".rec-recon").textContent).toMatch(
      /All 10 accounted for: 8 delivered, 1 bounced, 1 unsent\..*suppressed automatically/,
    );
    expect($$(".rec-people-table tbody tr")).toHaveLength(2);
    expect($(".rec-people-table tbody tr .rec-out").textContent).toBe("Hard bounce");
    expect($("#viewPublished")).toBeTruthy();
    expect(
      fake.calls.find((c) => c.url.pathname.endsWith("/deliveries"))?.url.searchParams.get("view"),
    ).toBe("failures");
    // Nothing accepted-but-unconfirmed: no settling poll runs.
    const reads = fake.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.calls.length).toBe(reads);
  });

  it("switches the recipients view and reloads from page one", async () => {
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send(),
          progress: progress({ state: "sent", phase: "complete" }),
          outcomes: outcomes(),
          slug: "owls",
          archive_url: null,
          published: true,
        }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: () => ({ deliveries: [], view: "all", page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $(".rec-view-btn[data-view='all']").click();
    await vi.advanceTimersByTimeAsync(10);
    const last = fake.calls.at(-1);
    expect(last?.url.searchParams.get("view")).toBe("all");
    expect($(".rec-view-btn[data-view='all']").getAttribute("aria-pressed")).toBe("true");
    expect($("#recRows").textContent).toMatch(/No recipients on this send/);
  });

  it("brings a bounce into the failures list when a settling poll moves the counts", async () => {
    let bounced = false;
    const settling = () =>
      outcomes(
        bounced
          ? { delivered: 7, bounced: 1, unsent: 0, accepted: 2 }
          : { delivered: 7, bounced: 0, unsent: 0, accepted: 3 },
      );
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send(),
          progress: progress({ state: "sent", phase: "settling" }),
          outcomes: settling(),
          slug: "owls",
          archive_url: null,
          published: true,
        }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: (req) => {
          const failures = bounced && req.url.searchParams.get("view") === "failures";
          return {
            deliveries: failures ? [rows[0]] : [],
            view: req.url.searchParams.get("view"),
            page: { ...page, total: failures ? 1 : 0 },
          };
        },
      },
    ]);
    const lists = () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/No delivery failures/);
    expect($(".rec-n.warn").textContent).toBe("0");

    bounced = true; // a bounce receipt lands before the next tick
    await vi.advanceTimersByTimeAsync(15000);
    expect($(".rec-n.warn").textContent).toBe("1");
    expect($$(".rec-people-table tbody tr")).toHaveLength(1);
    expect($(".rec-people-table .rec-email").textContent).toBe("b@x.y");
    expect($(".rec-people-table .rec-out").textContent).toBe("Hard bounce");
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("failures");
    expect(reload?.get("offset")).toBe("0");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("reloads the list only when a poll moves the counts, keeping the reader's view, search, and sort", async () => {
    let settled = outcomes({ delivered: 5, bounced: 0, unsent: 0, accepted: 5 });
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send(),
          progress: progress({ state: "sent", phase: "settling" }),
          outcomes: settled,
          slug: "owls",
          archive_url: null,
          published: true,
        }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: (req) => ({
          deliveries: rows,
          view: req.url.searchParams.get("view"),
          page: { ...page, total: 120, offset: Number(req.url.searchParams.get("offset")) },
        }),
      },
    ]);
    const lists = () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $(".rec-view-btn[data-view='all']").click();
    await vi.advanceTimersByTimeAsync(10);
    typeInto($<HTMLInputElement>(".rec-people-search"), "x.y");
    await vi.advanceTimersByTimeAsync(250);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($(".pager-range").textContent).toBe("51–100 of 120");
    const read = lists().length;

    await vi.advanceTimersByTimeAsync(15000); // nothing new: the reader stays on page two
    expect(lists().length).toBe(read);
    expect($(".pager-range").textContent).toBe("51–100 of 120");

    settled = outcomes({ delivered: 6, bounced: 0, unsent: 0, accepted: 4 });
    await vi.advanceTimersByTimeAsync(15000);
    expect(lists().length).toBe(read + 1);
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("all");
    expect(reload?.get("search")).toBe("x.y");
    expect(reload?.get("sort")).toBe("email");
    expect(reload?.get("dir")).toBe("asc");
    expect(reload?.get("offset")).toBe("0");
    expect($(".pager-range").textContent).toBe("1–50 of 120");
    expect($(".rec-view-btn[data-view='all']").getAttribute("aria-pressed")).toBe("true");
    expect($<HTMLInputElement>(".rec-people-search").value).toBe("x.y");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("lets the reader's own reload win over a poll's that answers later", async () => {
    let settled = outcomes({ delivered: 5, bounced: 0, unsent: 0, accepted: 5 });
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let failureReads = 0;
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send(),
          progress: progress({ state: "sent", phase: "settling" }),
          outcomes: settled,
          slug: "owls",
          archive_url: null,
          published: true,
        }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: (req) => {
          const view = req.url.searchParams.get("view");
          const answer = { deliveries: view === "failures" ? rows : [], view, page };
          // The mount's failures read answers at once; the poll's reload is held open.
          return view === "failures" && ++failureReads === 2
            ? new Promise((r) => (held = r)).then(() => answer)
            : answer;
        },
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    settled = outcomes({ delivered: 6, bounced: 0, unsent: 0, accepted: 4 });
    await vi.advanceTimersByTimeAsync(15000); // the tick's reload is now pending
    expect(failureReads).toBe(2);
    $(".rec-view-btn[data-view='delivered']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    release(); // the stale failures answer lands last
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    expect(document.querySelector(".rec-people-table")).toBeNull();
  });

  it("opens the live watch for a send in flight, polls, and flips to the record when it finishes", async () => {
    let state: "sending" | "sent" = "sending";
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send({ status: state }),
          progress: progress({ state }),
          outcomes: outcomes({ accepted: 0 }),
          slug: "owls",
          archive_url: null,
          published: state === "sent",
        }),
      },
      {
        path: "/sends/x1/progress",
        reply: () => progress({ state, phase: state === "sent" ? "complete" : "progressing" }),
      },
      {
        path: "/sends/x1/deliveries",
        reply: () => ({ deliveries: [], view: "failures", page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($(".watch-card")).toBeTruthy();
    expect($(".phase-pill").textContent).toBe("Sending");
    expect($$(".wbar")).toHaveLength(2);
    expect($(".wcounts").textContent).toMatch(/5.*Accepted/);
    const polls = () => fake.calls.filter((c) => c.url.pathname.endsWith("/progress")).length;
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls()).toBe(2);
    state = "sent";
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".watch-card")).toBeNull();
    expect($(".rec-card")).toBeTruthy(); // the frozen record now
  });

  it("puts the provider's refusal of the account at the top of the watch", async () => {
    const refused = progress({
      phase: "needs-attention",
      provider: {
        name: "resend",
        halt: {
          reason: "account",
          cause: "credentials",
          error: "resend batch 403: API key is not active",
          since: 1_000,
          retry_at: Date.now() + 12 * 60_000,
        },
      },
      conditions: [
        condition.refused("resend batch 403: API key is not active", Date.now() + 12 * 60_000),
      ],
    });
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send({ status: "sending" }),
          progress: refused,
          outcomes: outcomes({ accepted: 0 }),
          slug: "owls",
          archive_url: null,
          published: false,
        }),
      },
      { path: "/sends/x1/progress", reply: () => refused },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($(".phase-pill").textContent).toBe("Needs attention");
    const alert = $("#watchBody .health.red");
    expect(alert.textContent).toContain("The provider is refusing this account");
    expect(alert.textContent).toContain("resend batch 403: API key is not active");
    expect(alert.textContent).toContain("Replace the provider's API key or credentials");
    expect(document.querySelector("#resolveBtn")).toBeNull(); // Resolve is for a wedge only
    expect($(".wbar-sub").textContent).toMatch(/refusing this account/);
    expect($(".wbar-sub").textContent).toContain("next retry in 12 min");
  });

  it("stops polling when the reader navigates away, even with a tick's read in flight", async () => {
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let reads = 0;
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: send({ status: "sending" }),
          progress: progress(),
          outcomes: outcomes(),
          slug: null,
          archive_url: null,
          published: false,
        }),
      },
      {
        path: "/sends/x1/progress",
        // The first read answers at once (the mount); the tick's is held open.
        reply: () =>
          ++reads === 1 ? progress() : new Promise((r) => (held = r)).then(() => progress()),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    const polls = () => fake.calls.filter((c) => c.url.pathname.endsWith("/progress")).length;
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000); // the tick fires; its read is now pending
    expect(polls()).toBe(2);
    unmount(); // what navigating away does: the pending read is cut off with the mount
    release();
    await vi.advanceTimersByTimeAsync(9000);
    expect(polls()).toBe(2); // no reschedule
    expect(document.querySelector(".watch-card")).toBeNull(); // nothing painted back
  });
});
