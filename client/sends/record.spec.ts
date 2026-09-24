import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryOutcomes, Send, SendView } from "../../shared/sends";
import {
  $,
  $$,
  condition,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  sendServer,
  sendView,
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A sent send on the fake server: its read, the feed, and its outcomes all come from its
  // counters, and `receipt` moves them the way a delivery webhook does.
  const sentSend = (over: Partial<Send> = {}) => {
    const server = sendServer([send(over)]);
    return {
      routes: server.routes,
      receipt: (counts: Partial<Send>) => server.edit("x1", counts),
      remove: () => server.remove("x1"),
    };
  };
  const SETTLING = { c_delivered: 5, c_bounced: 0, c_unsent: 0, c_accepted: 5 };

  it("renders the frozen record: tiles, the reconciliation line, and the failures list first", async () => {
    fake = fakeApi([
      ...sentSend().routes,
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
    expect($("#recPill").textContent).toBe("Complete");
    // Nothing moves: the record follows its send at the idle pace, reading the feed and
    // nothing else, never the send's whole record again.
    const others = () => fake.calls.filter((c) => c.url.pathname !== "/sends/feed").length;
    const reads = others();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(others()).toBe(reads);
    expect(fake.calls.filter((c) => c.url.pathname === "/sends/feed").length).toBeLessThanOrEqual(
      4,
    );
    expect(fake.unhandled).toHaveLength(0);
  });

  const noRows = {
    path: "/sends/x1/deliveries",
    reply: () => ({ deliveries: [], view: "failures", page: { ...page, total: 0 } }),
  };

  it("reads Settling while receipts arrive, and turns Complete in place when the last lands", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recPill").textContent).toBe("Settling");
    expect($(".rec-meta").textContent).toMatch(/^Sent /);
    const card = $(".rec-card");
    sent.receipt({ c_delivered: 10, c_accepted: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#recPill").textContent).toBe("Complete");
    expect($(".rec-card")).toBe(card); // in place, not a remount
    expect($(".rec-n.ok").textContent).toBe("10");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("names each leftover recipient for what it is: only an accepted one awaits a receipt", async () => {
    const sent = sentSend({
      c_delivered: 5,
      c_bounced: 0,
      c_unsent: 0,
      c_accepted: 1,
      c_skipped: 2,
      c_pending: 1,
      c_in_flight: 1,
    });
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    const recon = () => $(".rec-recon").textContent ?? "";
    expect(recon()).toContain("1 accepted, awaiting a delivery receipt");
    expect(recon()).toContain(
      "2 skipped (unsubscribed or suppressed before hand-off, never mailed)",
    );
    expect(recon()).toContain("2 in flight"); // one not yet handed off counts as in flight
    expect(recon()).not.toMatch(/[2-9] accepted, awaiting/);
    // A report whose counters read the same buckets as the page's own read moves nothing.
    const lists = fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries")).length;
    sent.receipt({});
    await vi.advanceTimersByTimeAsync(3000);
    expect(recon()).toContain("2 in flight");
    expect(fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"))).toHaveLength(lists);
  });

  it("reads Canceled for a canceled send, with when, never Sent", async () => {
    fake = fakeApi(
      sentSend({
        status: "canceled",
        started_at: null,
        completed_at: 950_000,
        c_delivered: 0,
        c_bounced: 0,
        c_unsent: 0,
      }).routes,
    );
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recPill").textContent).toBe("Canceled");
    expect($(".rec-meta").textContent).toMatch(/^Canceled /);
    expect($(".rec-card").textContent).not.toMatch(/\bSent\b/);
    expect($(".rec-card").textContent).toMatch(/no one was mailed/);
    expect(document.querySelector(".rec-tiles")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  it("follows receipts past ten minutes with no cap, never re-reading the whole record", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(11 * 60_000); // past the old poll's forty ticks
    sent.receipt({ c_accepted: 4, c_complained: 1 }); // a late complaint
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".rec-n.danger").textContent).toBe("1");
    expect(fake.calls.filter((c) => c.url.pathname === "/sends/x1")).toHaveLength(1);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("goes back to the watch when a settling send resumes sending", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($(".rec-card")).toBeTruthy();
    // A Resolve that put ambiguous recipients back to be handed off, say.
    sent.receipt({ status: "sending", completed_at: null, c_accepted: 4, c_pending: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".watch-card")).toBeTruthy();
    expect(fake.unhandled).toHaveLength(0);
  });

  it("re-reads the page when its send is removed, and stops following", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    sent.remove(); // deleted with its post
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#app .error")).toBeTruthy(); // the re-read finds no send
    const feeds = fake.calls.filter((c) => c.url.pathname === "/sends/feed").length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls.filter((c) => c.url.pathname === "/sends/feed")).toHaveLength(feeds);
  });

  it("re-reads the page and follows again when its cursor is ahead of the database", async () => {
    const sent = sentSend(SETTLING);
    let ahead = true;
    const feed = sent.routes.find((r) => r.path === "/sends/feed");
    fake = fakeApi([
      {
        path: "/sends/feed",
        reply: (req) => {
          if (ahead) {
            ahead = false; // a local reset, once
            return jsonResponse({ error: "cursor_ahead", message: "reset" }, 409);
          }
          return feed?.reply(req);
        },
      },
      ...sent.routes,
      noRows,
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    const reads = () => fake.calls.filter((c) => c.url.pathname === "/sends/x1").length;
    expect(reads()).toBe(2); // its own read, then again after the refused cursor
    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".rec-n.ok").textContent).toBe("6"); // following again
  });

  it("switches the recipients view and reloads from page one", async () => {
    fake = fakeApi([
      ...sentSend().routes,
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
    const sent = sentSend({ c_delivered: 7, c_bounced: 0, c_unsent: 0, c_accepted: 3 });
    fake = fakeApi([
      ...sent.routes,
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

    bounced = true; // a bounce receipt lands
    sent.receipt({ c_accepted: 2, c_bounced: 1 });
    await vi.advanceTimersByTimeAsync(3000); // the layer's next read while it settles
    expect($(".rec-n.warn").textContent).toBe("1");
    expect($$(".rec-people-table tbody tr")).toHaveLength(1);
    expect($(".rec-people-table .rec-email").textContent).toBe("b@x.y");
    expect($(".rec-people-table .rec-out").textContent).toBe("Hard bounce");
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("failures");
    expect(reload?.get("offset")).toBe("0");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("reloads the list only when a poll moves the counts, keeping the reader's view, search, sort, and page", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([
      ...sent.routes,
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
    $<HTMLButtonElement>(".th-sort[data-sort='email']").click(); // email asc → desc
    await vi.advanceTimersByTimeAsync(10);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($(".pager-range").textContent).toBe("51–100 of 120");
    const read = lists().length;

    await vi.advanceTimersByTimeAsync(3000); // nothing new: the reader stays on page two
    expect(lists().length).toBe(read);
    expect($(".pager-range").textContent).toBe("51–100 of 120");

    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(lists().length).toBe(read + 1);
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("all");
    expect(reload?.get("search")).toBe("x.y");
    expect(reload?.get("sort")).toBe("email");
    expect(reload?.get("dir")).toBe("desc");
    expect(reload?.get("offset")).toBe("50");
    expect($(".pager-range").textContent).toBe("51–100 of 120");
    expect($(".rec-view-btn[data-view='all']").getAttribute("aria-pressed")).toBe("true");
    expect($<HTMLInputElement>(".rec-people-search").value).toBe("x.y");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("lets the reader's own reload win over a poll's that answers later", async () => {
    const sent = sentSend(SETTLING);
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let failureReads = 0;
    fake = fakeApi([
      ...sent.routes,
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
    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000); // the refresh's reload is now pending
    expect(failureReads).toBe(2);
    $(".rec-view-btn[data-view='delivered']").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    release(); // the stale failures answer lands last
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    expect(document.querySelector(".rec-people-table")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  // A settling record whose counts move on the second read, and a recipients list the
  // spec answers per request.
  const settlingRecord = (
    deliveries: (req: { url: URL }) => unknown,
  ): { moveCounts: () => void; lists: () => { url: URL }[] } => {
    const sent = sentSend(SETTLING);
    let delivered = SETTLING.c_delivered;
    fake = fakeApi([...sent.routes, { path: "/sends/x1/deliveries", reply: deliveries }]);
    return {
      moveCounts: () => {
        delivered += 1;
        sent.receipt({ c_delivered: delivered, c_accepted: 10 - delivered });
      },
      lists: () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries")),
    };
  };
  const pageOf = (req: { url: URL }, total: number) => {
    const offset = Number(req.url.searchParams.get("offset"));
    return {
      deliveries: offset < total ? rows : [],
      view: req.url.searchParams.get("view"),
      page: { ...page, total, offset },
    };
  };

  it("moves a reader past the end of a shrunken list to its last page", async () => {
    let total = 120;
    const { moveCounts, lists } = settlingRecord((req) => pageOf(req, total));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(10);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(10);
    expect($(".pager-range").textContent).toBe("101–120 of 120");

    total = 60; // the view now holds fewer rows than the reader's page starts at
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lists().at(-2)?.url.searchParams.get("offset")).toBe("100");
    expect(lists().at(-1)?.url.searchParams.get("offset")).toBe("50");
    expect($(".pager-range").textContent).toBe("51–60 of 60");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("keeps the rows when a refresh's reload fails, and says so only for the reader's own", async () => {
    let failing = false;
    const { moveCounts } = settlingRecord((req) =>
      failing ? jsonResponse({ error: "boom" }, 500) : pageOf(req, 120),
    );
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($$(".rec-people-table tbody tr")).toHaveLength(2);

    failing = true;
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect($$(".rec-people-table tbody tr")).toHaveLength(2); // still the reader's rows
    expect(document.querySelector("#recRows .error, #recRows [role='alert']")).toBeNull();

    $<HTMLButtonElement>(".pager-next").click(); // the reader's own load does say it failed
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".rec-people-table")).toBeNull();
    expect($("#recRows").textContent).toMatch(/boom/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("shows the error to a reader whose own load a failing refresh overtook", async () => {
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let failing = false;
    const { moveCounts } = settlingRecord((req) => {
      if (failing) {
        return jsonResponse({ error: "boom" }, 500);
      }
      // The reader's page-two read is held open, so the refresh overtakes it.
      return req.url.searchParams.get("offset") === "50"
        ? new Promise((r) => (held = r)).then(() => pageOf(req, 120))
        : pageOf(req, 120);
    });
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $<HTMLButtonElement>(".pager-next").click(); // the reader's load, now pending
    await vi.advanceTimersByTimeAsync(10);
    failing = true;
    moveCounts();
    await vi.advanceTimersByTimeAsync(15000); // the refresh's reload fails
    expect($("#recRows").textContent).toMatch(/boom/);
    release(); // the overtaken answer lands last and paints nothing
    await vi.advanceTimersByTimeAsync(10);
    expect($("#recRows").textContent).toMatch(/boom/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("keeps keyboard focus on the same control across a refresh's repaint", async () => {
    const { moveCounts } = settlingRecord((req) => pageOf(req, 120));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $<HTMLButtonElement>(".pager-next").focus();
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe($(".pager-next"));

    $<HTMLButtonElement>(".th-sort[data-sort='email']").focus();
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe($(".th-sort[data-sort='email']"));
    expect(fake.unhandled).toHaveLength(0);
  });

  it("hands a scheduled send's page to its editor, in place of its history entry", async () => {
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({
          send: sendView(send({ status: "scheduled", started_at: null, completed_at: null }), {
            phase: "scheduled",
          }),
          outcomes: outcomes(),
          cursor: "1.1",
        }),
      },
    ]);
    // happy-dom's replace() pushes an entry as assign() does, so the spec asserts the call.
    const replace = vi.spyOn(location, "replace");
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect(replace).toHaveBeenCalledWith("#/edit/p1"); // so Back skips this send URL
    expect(location.hash).toBe("#/edit/p1");
    expect(fake.unhandled).toHaveLength(0);
  });

  /** The feed the watch follows, answering with the send as `current()` has it, every read
   *  a change (a new `rev`), read again in 3 s. */
  const feedOf = (current: () => SendView) => {
    let seq = 1;
    return {
      path: "/sends/feed",
      reply: () => {
        seq += 1;
        return {
          now: Date.now(),
          sends: [{ ...current(), rev: seq }],
          removed: [],
          cursor: `${seq}.${Date.now()}`,
          more: false,
          conditions: [],
          read_again_at: Date.now() + 3000,
        };
      },
    };
  };
  const feedReads = () => fake.calls.filter((c) => c.url.pathname === "/sends/feed").length;

  it("opens the live watch for a send in flight, follows it through the feed, and flips to the record when it finishes", async () => {
    let status: "sending" | "sent" = "sending";
    const current = () =>
      sendView(
        send({
          status,
          c_pending: 4,
          c_in_flight: 1,
          c_accepted: 5,
          c_delivered: 0,
          c_bounced: 0,
          c_unsent: 0,
          completed_at: null,
        }),
        {
          phase: status === "sent" ? "complete" : "progressing",
        },
      );
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({ send: current(), outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(current),
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
    // The watch keeps no poll of its own: the layer reads the feed from the page's cursor.
    expect(feedReads()).toBe(1);
    expect(
      fake.calls.find((c) => c.url.pathname === "/sends/feed")?.url.searchParams.get("since"),
    ).toBe("1.1");
    await vi.advanceTimersByTimeAsync(3000);
    expect(feedReads()).toBe(2);
    status = "sent";
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".watch-card")).toBeNull();
    expect($(".rec-card")).toBeTruthy(); // the frozen record now
  });

  it("puts the provider's refusal of the account at the top of the watch", async () => {
    const refused = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs-attention",
      provider: {
        name: "resend",
        halt: {
          reason: "account",
          cause: "credentials",
          error: "resend batch 403: API key is not active",
          retries: 1,
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
        reply: () => ({ send: refused, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(() => refused),
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

  it("counts a halt's next retry down on the clock while no report arrives", async () => {
    const retryAt = Date.now() + 12 * 60_000;
    const refused = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs-attention",
      provider: {
        name: "ses",
        halt: {
          reason: "account",
          cause: "quota",
          error: "quota exceeded",
          retries: 1,
          since: 1_000,
          retry_at: retryAt,
        },
      },
      conditions: [condition.refused("quota exceeded", retryAt)],
    });
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({ send: refused, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      {
        // Nothing about the send changes: every read reports no send.
        path: "/sends/feed",
        reply: () => ({
          now: Date.now(),
          sends: [],
          removed: [],
          cursor: `1.${Date.now()}`,
          more: false,
          conditions: [],
          read_again_at: Date.now() + 60_000,
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect($(".wbar-sub").textContent).toContain("next retry in 12 min");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect($(".wbar-sub").textContent).toContain("next retry in 9 min");
  });

  it("offers Resolve while the server lists it, and names its count", async () => {
    const wedged = sendView(send({ status: "sending", c_in_flight: 2, completed_at: null }), {
      phase: "needs-attention",
      conditions: [condition.wedged(2, "x1")],
      actions: [{ name: "resolve", method: "POST", path: "/sends/x1/resolve" }],
    });
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({ send: wedged, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(() => wedged),
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    $("#resolveBtn").click();
    expect($(".modal h3").textContent).toBe("Resolve 2 ambiguous deliveries");
  });

  it("stops following when the reader navigates away, even with a read in flight", async () => {
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let reads = 0;
    const view = sendView(send({ status: "sending", completed_at: null }), {
      phase: "progressing",
    });
    const feed = feedOf(() => view);
    fake = fakeApi([
      {
        path: "/sends/x1",
        reply: () => ({ send: view, outcomes: outcomes(), cursor: "1.1" }),
      },
      {
        path: "/sends/feed",
        // The first read answers at once; the next is held open.
        reply: () =>
          ++reads === 1 ? feed.reply() : new Promise((r) => (held = r)).then(() => feed.reply()),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(10);
    expect(feedReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000); // the next read is now pending
    expect(feedReads()).toBe(2);
    unmount(); // what navigating away does: the pending read is cut off with the mount
    release();
    await vi.advanceTimersByTimeAsync(9000);
    expect(feedReads()).toBe(2); // no reschedule
    expect(document.querySelector(".watch-card")).toBeNull(); // nothing painted back
  });
});
