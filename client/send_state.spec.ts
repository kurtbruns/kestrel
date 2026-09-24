import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSendCursor, encodeSendCursor } from "../shared/cursor";
import type { SendFeedResponse, SendPhase, SendStatus, SendView } from "../shared/sends";
import {
  followSend,
  followSends,
  type ListRead,
  readSendsNow,
  type SendsFollower,
  type SendsUpdate,
  type StageChange,
  stageOf,
} from "./send_state";
import { type FakeApi, fakeApi, jsonResponse, sendView } from "./test/support";

const NOW = 1_700_000_000_000;

/** A send as the feed reports it: a `SendView` in the given status and phase. */
function live(
  id: string,
  status: SendStatus,
  phase: SendPhase,
  over: Partial<SendView> = {},
): SendView {
  return sendView(
    {
      id,
      post_id: `p-${id}`,
      status,
      fire_at: NOW - 30_000,
      subject: `Subject ${id}`,
      recipient_count: 10,
      locked_until: null,
      scheduled_at: NOW - 3_600_000,
      started_at: null,
      completed_at: null,
      audience_resolved_at: null,
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
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      c_skipped: 0,
      c_unsent: 0,
      rev: 0,
    },
    { phase, ...over },
  );
}

/**
 * A stateful server. `write(send)` is any client's (or the sweep's) change to a send: it
 * takes the next number in the change sequence. It answers /sends/feed the way the Worker
 * does: every send changed after the cursor, a new cursor, and when to read again by its
 * own clock (`pace` after its `now`, which runs `skew` ahead of the page's).
 */
function server() {
  const state = {
    sends: new Map<string, { send: SendView; rev: number }>(),
    removed: new Map<string, number>(),
    seq: 0,
    pace: 60_000,
    skew: 0,
    fail: 0 as number, // a status to fail reads with, or 0
    /** While set, a read is held open until it resolves. */
    hold: null as Promise<void> | null,
  };
  const cursorNow = () => encodeSendCursor({ seq: state.seq, at: Date.now() + state.skew });
  const write = (send: SendView) => {
    state.seq += 1;
    state.sends.set(send.id, { send, rev: state.seq });
  };
  /** A send deleted with its post: gone, with a tombstone at the next number. */
  const remove = (id: string) => {
    state.seq += 1;
    state.sends.delete(id);
    state.removed.set(id, state.seq);
  };
  /** The database reset: every send gone and the sequence back to zero. */
  const reset = () => {
    state.sends.clear();
    state.removed.clear();
    state.seq = 0;
  };
  const fake = fakeApi([
    {
      path: "/sends/feed",
      reply: async (req) => {
        await state.hold;
        if (state.fail) {
          return jsonResponse({ error: "internal_error" }, state.fail);
        }
        const raw = req.url.searchParams.get("since");
        const since = raw === null ? null : decodeSendCursor(raw);
        if (raw !== null && !since) {
          return jsonResponse({ error: "bad_request", field: "since" }, 400);
        }
        if (since && since.seq > state.seq) {
          return jsonResponse({ error: "cursor_ahead", field: "since" }, 409);
        }
        const now = Date.now() + state.skew;
        const all = [...state.sends.values()];
        const body: SendFeedResponse = {
          now,
          sends: (since
            ? all.filter((s) => s.rev > since.seq)
            : all.filter((s) => ["due", "sending", "sent"].includes(stageOf(s.send)))
          ).map((s) => s.send),
          removed: since
            ? [...state.removed]
                .filter(([, rev]) => rev > since.seq)
                .map(([id, rev]) => ({ id, rev }))
            : [],
          cursor: cursorNow(),
          more: false,
          conditions: [],
          read_again_at: now + state.pace,
        };
        return body;
      },
    },
  ]);
  const reads = () => fake.calls.filter((c) => c.url.pathname === "/sends/feed");
  /** What a page's own GET /sends would have read: every send, and the cursor. */
  const list = (): ListRead => ({
    cursor: cursorNow(),
    sends: [...state.sends.values()].map(({ send }) => ({
      id: send.id,
      status: send.status,
      phase: send.phase,
    })),
  });
  return { state, fake, reads, write, remove, reset, list, cursorNow };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A follower of every send that only takes updates. */
const on = (update: (u: SendsUpdate) => void = () => {}): SendsFollower => ({
  update,
  stale: () => {},
});

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

  it("reads first from the page's own list cursor, so a change between the two is not missed", async () => {
    srv.write(live("x", "scheduled", "scheduled", { fire_at: NOW + 3_600_000 }));
    const from = srv.list();
    srv.write(live("x", "canceled", "canceled")); // lands after the list read
    const updates: SendsUpdate[] = [];
    followSends(
      from,
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()[0]?.url.searchParams.get("since")).toBe(from.cursor);
    expect(moves(updates.flatMap((u) => u.changes))).toEqual(["x:scheduled>canceled"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("reads again when the server says, by the server's clock", async () => {
    srv.state.skew = 3_600_000; // the server's clock an hour ahead of the page's
    srv.state.pace = 3000;
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(2);
    srv.state.pace = 15_000; // only settling, now
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(srv.reads()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(srv.reads()).toHaveLength(4);
  });

  it("reads about once a minute while nothing moves, and says nothing when nothing changed", async () => {
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.reads()).toHaveLength(11); // the first, then one a minute
    expect(updates).toEqual([]);
  });

  it("announces the other client's cancel of a far-scheduled send within one idle read", async () => {
    srv.write(live("far", "scheduled", "scheduled", { fire_at: NOW + 3 * 86_400_000 }));
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    srv.write(live("far", "canceled", "canceled")); // Claude, through the API
    await vi.advanceTimersByTimeAsync(50_000);
    expect(moves(updates.flatMap((u) => u.changes))).toEqual(["far:scheduled>canceled"]);
  });

  it("announces every move of a send, a send that finishes between two reads included", async () => {
    srv.write(live("x", "scheduled", "scheduled", { fire_at: NOW + 60_000 }));
    srv.state.pace = 3000;
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.write(live("x", "scheduled", "due"));
    await vi.advanceTimersByTimeAsync(3_000);
    srv.write(live("x", "sending", "progressing"));
    srv.write(live("x", "sent", "settling", { completed_at: Date.now() }));
    await vi.advanceTimersByTimeAsync(3_000);
    srv.write(live("x", "sent", "complete"));
    srv.write(live("y", "scheduled", "scheduled", { fire_at: NOW + 86_400_000 })); // new
    await vi.advanceTimersByTimeAsync(3_000);
    expect(updates.map((u) => moves(u.changes))).toEqual([
      ["x:scheduled>due"],
      ["x:due>sent"],
      ["x:sent>complete", "y:null>scheduled"],
    ]);
  });

  it("pauses while the tab is hidden and reads at once when it is shown again", async () => {
    srv.state.pace = 3000;
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(0);
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
    setHidden(true);
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.reads()).toHaveLength(1);
  });

  it("shares one read among the pages following, from the earlier of their cursors, and stops when the last one leaves", async () => {
    srv.state.pace = 3000;
    srv.write(live("x", "sending", "progressing"));
    const older = srv.list();
    srv.write(live("x", "sending", "progressing", { rev: 11 }));
    const newer = srv.list();
    const a = page();
    const b = page();
    const seen: string[] = [];
    followSends(newer, on(), a.signal);
    followSend(
      {
        cursor: older.cursor,
        send: { id: "x", status: "sending", phase: "progressing" },
      },
      { update: (s) => seen.push(`${s.rev}`), removed: () => {}, stale: () => {} },
      b.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(1);
    expect(srv.reads()[0]?.url.searchParams.get("since")).toBe(older.cursor);
    expect(seen).toEqual(["11"]); // the change after the older cursor reached its follower
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(2);
    a.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(3);
    b.abort();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.reads()).toHaveLength(3);
  });

  it("follows one send by id, reporting its counts when it changes and its stage when it moves", async () => {
    srv.state.pace = 3000;
    srv.write(live("x", "sending", "progressing"));
    srv.write(live("other", "sending", "progressing"));
    const seen: string[] = [];
    followSend(
      {
        cursor: srv.cursorNow(),
        send: { id: "x", status: "sending", phase: "progressing" },
      },
      {
        update: (s, c) => seen.push(`${s.counts.accepted}${c ? ` ${c.from}>${c.to}` : ""}`),
        removed: () => seen.push("removed"),
        stale: () => {},
      },
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.write(live("other", "sent", "settling")); // not this page's send
    srv.write(
      live("x", "sending", "progressing", {
        counts: { ...live("x", "sending", "progressing").counts, accepted: 4 },
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    srv.write(live("x", "sent", "settling", { completed_at: Date.now() }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(["4", "0 sending>sent"]);
  });

  it("keeps quiet when a read fails, tries again spaced out, and misses nothing once it succeeds", async () => {
    srv.state.pace = 3000;
    srv.write(live("x", "sending", "progressing"));
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.state.fail = 500;
    srv.write(live("x", "sent", "settling"));
    await vi.advanceTimersByTimeAsync(3_000); // fails
    await vi.advanceTimersByTimeAsync(3_000); // fails again
    expect(srv.reads()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(srv.reads()).toHaveLength(3); // the next try waits 6 s
    srv.state.fail = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(srv.reads()).toHaveLength(4);
    expect(updates.map((u) => moves(u.changes))).toEqual([["x:sending>sent"]]);
  });

  it("cuts off a read that never answers, and treats it as failed, so the layer keeps reading", async () => {
    srv.state.pace = 3000;
    srv.write(live("x", "sending", "progressing"));
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.state.hold = new Promise(() => {}); // a connection that never settles
    srv.write(live("x", "sent", "settling"));
    await vi.advanceTimersByTimeAsync(3_000); // the read goes out, and hangs
    expect(srv.reads()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000); // cut off
    srv.state.hold = null;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(srv.reads()).toHaveLength(2); // backed off like any failed read
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(srv.reads()).toHaveLength(3);
    expect(srv.reads()[2]?.url.searchParams.get("since")).toBe(
      srv.reads()[1]?.url.searchParams.get("since"),
    );
    expect(updates.map((u) => moves(u.changes))).toEqual([["x:sending>sent"]]);
  });

  it("starts again from what can change on its own when the server refuses its cursor", async () => {
    srv.write(live("x", "sending", "progressing"));
    const updates: SendsUpdate[] = [];
    followSends(
      { cursor: "from-an-older-deploy", sends: [] },
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(srv.reads()).toHaveLength(2);
    expect(srv.reads()[1]?.url.searchParams.has("since")).toBe(false);
    expect(moves(updates.flatMap((u) => u.changes))).toEqual(["x:null>sending"]);
  });

  it("tells a page following every send which sends were removed", async () => {
    srv.write(live("x", "canceled", "canceled"));
    const updates: SendsUpdate[] = [];
    followSends(
      srv.list(),
      on((u) => updates.push(u)),
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.remove("x"); // its post deleted
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates.map((u) => u.removed)).toEqual([["x"]]);
  });

  it("tells a page following one send that it was removed", async () => {
    srv.write(live("x", "canceled", "canceled"));
    const seen: string[] = [];
    followSend(
      {
        cursor: srv.cursorNow(),
        send: { id: "x", status: "canceled", phase: "canceled" },
      },
      { update: () => seen.push("update"), removed: () => seen.push("removed"), stale: () => {} },
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    srv.remove("x");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual(["removed"]);
  });

  it("hands every page back to its own read when the server says the cursor is ahead of its database", async () => {
    srv.write(live("x", "sending", "progressing"));
    srv.write(live("y", "scheduled", "scheduled"));
    const stale: string[] = [];
    followSends(srv.list(), { update: () => {}, stale: () => stale.push("list") }, page().signal);
    followSend(
      {
        cursor: srv.cursorNow(),
        send: { id: "x", status: "sending", phase: "progressing" },
      },
      { update: () => {}, removed: () => {}, stale: () => stale.push("send") },
      page().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(1);
    srv.reset(); // a local reset, or a restore
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.reads()).toHaveLength(2);
    expect(stale.sort()).toEqual(["list", "send"]);
    // Dropped: nothing reads again until a page follows anew from a fresh read.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.reads()).toHaveLength(2);
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(3);
    expect(srv.reads()[2]?.url.searchParams.get("since")).toBe(srv.list().cursor);
  });

  it("reads at once when a page has just acted", async () => {
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    readSendsNow(); // a cancel, a move, a Resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(2);
  });

  it("serves a page that joins while a read is out with a read of its own", async () => {
    srv.state.pace = 3000;
    followSends(srv.list(), on(), page().signal);
    await vi.advanceTimersByTimeAsync(0);
    let release = () => {};
    srv.state.hold = new Promise((r) => {
      release = r;
    });
    await vi.advanceTimersByTimeAsync(3_000); // the next read goes out, and is held
    expect(srv.reads()).toHaveLength(2);
    const joinedAt = srv.list();
    followSends(joinedAt, on(), page().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(2); // no second read while one is out
    srv.state.hold = null;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.reads()).toHaveLength(3);
  });
});
