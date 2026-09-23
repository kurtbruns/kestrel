import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryOutcomes, Send, SendProgress } from "../../shared/sends";
import { $, $$, type FakeApi, fakeApi, mount, resetShell, unmount } from "../test/support";
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
  remade_at: null,
  halt_reason: null,
  halt_error: null,
  halted_at: null,
  c_pending: 0,
  c_in_flight: 0,
  c_accepted: 0,
  c_delivered: 8,
  c_bounced: 1,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 1,
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
  attention: { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: false },
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
        halt: { reason: "account", error: "resend batch 403: API key is not active", since: 1_000 },
      },
      attention: { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: true },
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
    expect(document.querySelector("#resolveBtn")).toBeNull(); // Resolve is for a wedge only
    expect($(".wbar-sub").textContent).toMatch(/refusing this account/);
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
