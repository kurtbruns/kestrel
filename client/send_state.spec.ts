import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSend, LiveSendsResponse, SendPhase, SendStatus } from "../shared/sends";
import {
  followSend,
  followSends,
  nextReadIn,
  readSendsNow,
  type SendsUpdate,
  type StageChange,
  stageOf,
} from "./send_state";
import { type FakeApi, fakeApi, jsonResponse } from "./test/support";

const NOW = 1_700_000_000_000;

function live(
  id: string,
  state: SendStatus,
  phase: SendPhase,
  over: Partial<LiveSend> = {},
): LiveSend {
  return {
    id,
    post_id: `p-${id}`,
    subject: `Subject ${id}`,
    fire_at: NOW - 30_000,
    started_at: null,
    completed_at: null,
    state,
    phase,
    total: 10,
    counts: {
      pending: 0,
      in_flight: 0,
      accepted: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      skipped: 0,
      unsent: 0,
    },
    dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: null },
    delivery: { confirmed: 0, percent_of_accepted: 0 },
    provider: { name: "fake", halt: null },
    attention: { wedged: false, wedged_count: 0, stuck: false, missed: false, refused: false },
    ...over,
  };
}

/**
 * A stateful server: `sends` is every send it knows, `next` the next fire time. It answers
 * /sends/live the way the Worker does: the live ones, the named ones that aren't, and the
 * server's clock.
 */
function server() {
  const state = {
    sends: [] as LiveSend[],
    next: null as number | null,
    fail: false,
    /** While set, a read is held open until it resolves. */
    hold: null as Promise<void> | null,
  };
  const fake = fakeApi([
    {
      path: "/sends/live",
      reply: async (req) => {
        await state.hold;
        if (state.fail) {
          return jsonResponse({ error: "internal_error" }, 500);
        }
        const ids = (req.url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        const isLive = (s: LiveSend) => ["due", "sending", "sent"].includes(stageOf(s));
        const body: LiveSendsResponse = {
          now: Date.now(),
          sends: state.sends.filter(isLive),
          named: state.sends.filter((s) => !isLive(s) && ids.includes(s.id)),
          next_fire_at: state.next,
        };
        return body;
      },
    },
  ]);
  const reads = () => fake.calls.filter((c) => c.url.pathname === "/sends/live");
  return { state, fake, reads };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

const moves = (changes: StageChange[]) => changes.map((c) => `${c.send.id}:${c.from}>${c.to}`);

describe("stageOf", () => {
  it("names where a send is in its life from its state and phase", () => {
    expect(stageOf(live("a", "scheduled", "scheduled"))).toBe("scheduled");
    expect(stageOf(live("a", "scheduled", "due"))).toBe("due");
    expect(stageOf(live("a", "sending", "backing-off"))).toBe("sending");
    expect(stageOf(live("a", "sending", "needs-attention"))).toBe("sending");
    expect(stageOf(live("a", "sent", "settling"))).toBe("sent");
    expect(stageOf(live("a", "sent", "complete"))).toBe("complete");
    expect(stageOf(live("a", "canceled", "canceled"))).toBe("canceled");
  });
});

describe("nextReadIn", () => {
  const res = (sends: LiveSend[], next: number | null = null): LiveSendsResponse => ({
    now: NOW,
    sends,
    named: [],
    next_fire_at: next,
  });
  const settling = (ago: number) => live("s", "sent", "settling", { completed_at: NOW - ago });

  it("reads every 3 s while a send is due or sending", () => {
    expect(nextReadIn(res([live("a", "scheduled", "due")]))).toBe(3000);
    expect(nextReadIn(res([live("a", "sending", "progressing"), settling(3_000_000)]))).toBe(3000);
  });

  it("follows receipts at the pace they arrive: 3 s for two minutes, 15 s to ten, then 60 s", () => {
    expect(nextReadIn(res([settling(0)]))).toBe(3000);
    expect(nextReadIn(res([settling(119_000)]))).toBe(3000);
    expect(nextReadIn(res([settling(121_000)]))).toBe(15_000);
    expect(nextReadIn(res([settling(599_000)]))).toBe(15_000);
    expect(nextReadIn(res([settling(601_000)]))).toBe(60_000);
    // The youngest settling send sets the pace.
    expect(nextReadIn(res([settling(900_000), { ...settling(30_000), id: "t" }]))).toBe(3000);
  });

  it("with nothing live, wakes once when the next send comes due, by the server's clock", () => {
    expect(nextReadIn(res([]))).toBeNull();
    expect(nextReadIn(res([], NOW + 90_000))).toBe(91_000);
    expect(nextReadIn(res([settling(900_000)], NOW + 10_000))).toBe(11_000); // whichever is sooner
  });
});

describe("the send-state layer", () => {
  let srv: ReturnType<typeof server>;
  let fake: FakeApi;
  let pages: AbortController[];
  const page = () => {
    const c = new AbortController();
    pages.push(c);
    return c;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setHidden(false);
    srv = server();
    fake = srv.fake;
    pages = [];
  });
  afterEach(() => {
    for (const p of pages) {
      p.abort();
    }
    fake.restore();
    vi.useRealTimers();
  });

  it("reads once when a page follows, and makes no request while nothing can change on its own", async () => {
    const updates: SendsUpdate[] = [];
    const first = await followSends((u) => updates.push(u), page().signal);
    expect(first).toEqual({ sends: [], changes: [] });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(srv.reads()).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  it("wakes when the next send comes due, follows it every 3 s, and announces every move, a send that finishes between two reads included", async () => {
    srv.state.sends = [live("x", "scheduled", "scheduled", { fire_at: NOW + 60_000 })];
    srv.state.next = NOW + 60_000;
    const updates: SendsUpdate[] = [];
    await followSends((u) => updates.push(u), page().signal);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(srv.reads()).toHaveLength(1); // a countdown needs no network
    srv.state.sends = [live("x", "scheduled", "due", { fire_at: NOW + 60_000 })];
    srv.state.next = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(srv.reads()).toHaveLength(2);
    expect(moves(updates.flatMap((u) => u.changes))).toEqual(["x:null>due"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(3); // due: every 3 s, waiting on the sweep
    expect(updates.at(-1)?.changes).toEqual([]);
    // The sweep starts it and it finishes dispatch before the next read.
    srv.state.sends = [
      live("x", "sent", "settling", { completed_at: Date.now(), started_at: Date.now() }),
    ];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(moves(updates.at(-1)?.changes ?? [])).toEqual(["x:due>sent"]);
    // Its last receipt lands: it leaves the live set, and the layer still says where it went.
    srv.state.sends = [live("x", "sent", "complete", { completed_at: NOW + 66_000 })];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads().at(-1)?.url.searchParams.get("ids")).toBe("x");
    expect(moves(updates.at(-1)?.changes ?? [])).toEqual(["x:sent>complete"]);
    expect(updates.at(-1)?.sends).toEqual([]);
    const done = srv.reads().length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.reads()).toHaveLength(done); // nothing live, nothing coming due: silent
  });

  it("says a due send was canceled or moved when it leaves without going out", async () => {
    srv.state.sends = [live("c", "scheduled", "due"), live("m", "scheduled", "due")];
    const updates: SendsUpdate[] = [];
    const first = await followSends((u) => updates.push(u), page().signal);
    expect(first.sends.map((s) => s.id)).toEqual(["c", "m"]);
    srv.state.sends = [
      live("c", "canceled", "canceled"),
      live("m", "scheduled", "scheduled", { fire_at: NOW + 3_600_000 }),
    ];
    srv.state.next = NOW + 3_600_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(moves(updates[0]?.changes ?? [])).toEqual(["c:due>canceled", "m:due>scheduled"]);
  });

  it("backs off while the only send is settling", async () => {
    srv.state.sends = [live("s", "sent", "settling", { completed_at: NOW - 100_000 })];
    await followSends(() => {}, page().signal);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(2); // 100 s after dispatch: still the 3 s pace
    await vi.advanceTimersByTimeAsync(30_000);
    // Past two minutes, the pace eases to 15 s.
    const at = srv.reads().length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(srv.reads()).toHaveLength(at + 1);
  });

  it("pauses while the tab is hidden and reads at once when it is shown again", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    await followSends(() => {}, page().signal);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.reads()).toHaveLength(1);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(3); // and back on its cadence
  });

  it("gives a page opened in a hidden tab its first read, then waits to be shown", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    setHidden(true);
    expect((await followSends(() => {}, page().signal)).sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.reads()).toHaveLength(1);
  });

  it("shares one read among the pages following, and stops when the last one leaves", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    const a = page();
    const b = page();
    await Promise.all([followSends(() => {}, a.signal), followSend("x", () => {}, b.signal)]);
    expect(srv.reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(2);
    a.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(3);
    b.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.reads()).toHaveLength(3);
  });

  it("follows one send by id, whatever its state", async () => {
    srv.state.sends = [live("r", "sent", "complete"), live("x", "sending", "progressing")];
    const seen: [string, string | null][] = [];
    const first = await followSend(
      "r",
      (s, c) => seen.push([s.phase, c?.to ?? null]),
      page().signal,
    );
    expect(first?.phase).toBe("complete"); // named: not live, but asked for
    expect(srv.reads()[0]?.url.searchParams.get("ids")).toBe("r");
    await vi.advanceTimersByTimeAsync(3_000); // another send keeps the layer reading
    expect(seen).toEqual([["complete", null]]);
    expect(await followSend("nope", () => {}, page().signal)).toBeNull();
  });

  it("reports a send's counts on every read and its stage when it moves", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    const seen: string[] = [];
    await followSend(
      "x",
      (s, c) => seen.push(`${s.counts.accepted}${c ? ` ${c.from}>${c.to}` : ""}`),
      page().signal,
    );
    srv.state.sends = [
      live("x", "sending", "progressing", {
        counts: { ...live("x", "sending", "progressing").counts, accepted: 4 },
      }),
    ];
    await vi.advanceTimersByTimeAsync(3_000);
    srv.state.sends = [live("x", "sent", "settling", { completed_at: Date.now() })];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(["4", "0 sending>sent"]);
  });

  it("keeps quiet when a background read fails, and tries again, spaced out", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    const updates: SendsUpdate[] = [];
    await followSends((u) => updates.push(u), page().signal);
    srv.state.fail = true;
    await vi.advanceTimersByTimeAsync(3_000); // fails
    await vi.advanceTimersByTimeAsync(3_000); // fails again
    expect(srv.reads()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(srv.reads()).toHaveLength(3); // the next try waits 6 s
    srv.state.fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(srv.reads()).toHaveLength(4);
    expect(updates).toHaveLength(1); // the failures said nothing
  });

  it("rejects a page's first read when it fails, as any read the page loads with would", async () => {
    srv.state.fail = true;
    await expect(followSends(() => {}, page().signal)).rejects.toMatchObject({ status: 500 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.reads()).toHaveLength(1); // that page is gone: nothing retries for it
  });

  it("reads at once when a page has just acted", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    await followSends(() => {}, page().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    readSendsNow(); // a cancel, a move, a Resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(2);
  });

  it("serves a page that joins while a read is out with a read of its own", async () => {
    srv.state.sends = [live("x", "sending", "progressing")];
    await followSends(() => {}, page().signal);
    let release = () => {};
    srv.state.hold = new Promise((r) => {
      release = r;
    });
    await vi.advanceTimersByTimeAsync(3_000); // the next read goes out, and is held
    expect(srv.reads()).toHaveLength(2);
    const joined = followSend("y", () => {}, page().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(2); // no second read while one is out
    srv.state.hold = null;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await joined).toBeNull();
    expect(srv.reads()).toHaveLength(3);
    expect(srv.reads().at(-1)?.url.searchParams.get("ids")).toBe("x,y");
  });
});
