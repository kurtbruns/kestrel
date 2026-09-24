// The send-state layer: one shared read of the send feed (GET /sends/feed), which pages
// follow instead of polling, so every page tells the same story about a send and keeps up
// with it, whichever client changed it (docs/DESIGN.md §9). The server says when to read
// again; the layer keeps to it.

import { earlierCursor } from "../shared/cursor";
import type {
  LiveSend,
  Send,
  SendFeedResponse,
  SendPhase,
  SendProgress,
  SendStatus,
} from "../shared/sends";
import { ApiError, api } from "./api";

/**
 * Where a send is in its life, as a page reacts to it: in the review window, due (its
 * fire time has passed and the next sweep starts it), sending, sent with receipts still
 * arriving, complete, or canceled. Coarser than the phase: a send that retries, backs off,
 * or needs attention is still sending.
 */
export type SendStage = "scheduled" | "due" | "sending" | "sent" | "complete" | "canceled";

/** A send's stage, from its state and derived phase. */
export function stageOf(s: { state: SendStatus; phase: SendPhase }): SendStage {
  switch (s.state) {
    case "scheduled":
      return s.phase === "due" ? "due" : "scheduled";
    case "sending":
      return "sending";
    case "sent":
      return s.phase === "complete" ? "complete" : "sent";
    default:
      return "canceled";
  }
}

/** A send that moved since a follower last looked; `from` is null for one it had not seen. */
export interface StageChange {
  send: LiveSend;
  from: SendStage | null;
  to: SendStage;
}

/** What a follower of every send gets from a read that found something changed. */
export interface SendsUpdate {
  /** Every send that changed since the follower's last update, soonest fire first. */
  sends: LiveSend[];
  /** Those whose stage moved, a send the follower had not seen included. */
  changes: StageChange[];
  /** The ids of sends removed since (deleted with their post). */
  removed: string[];
}

/**
 * What a page does with what the layer reads. `stale` is the server saying the page's
 * cursor is ahead of its database (reset or restored since): nothing after it will ever be
 * reported, so the layer stops following for every page, and each re-reads its own list or
 * send and follows again from that read.
 */
export interface SendsFollower {
  update(update: SendsUpdate): void;
  stale(): void;
}

/** What a page following one send does with what the layer reads: `update` for each read
 *  that changed it, `removed` once it is deleted, `stale` as for `SendsFollower`. */
export interface SendFollower {
  update(send: LiveSend, change: StageChange | null): void;
  removed(): void;
  stale(): void;
}

/** Where a page's own read of sends (`GET /sends`) stood: its cursor, and the rows it painted. */
export interface ListRead {
  cursor: string;
  sends: readonly { id: string; status: SendStatus; phase: SendPhase }[];
}

/** Where a page's own read of one send (`GET /sends/:id`) stood. */
export interface SendRead {
  cursor: string;
  send: Pick<Send, "id" | "status">;
  progress: Pick<SendProgress, "phase">;
}

// A failed read is tried again after this, doubling up to the cap while it keeps failing.
const RETRY_MS = 3000;
const RETRY_MAX_MS = 60_000;

/** One page's interest in the feed. */
interface Follower {
  /** Take a read it was part of. */
  take(res: SendFeedResponse): void;
  /** Its cursor is ahead of the database: it has been dropped, and reads again. */
  stale(): void;
}

const followers = new Set<Follower>();
// Where the layer's last read stood, and the earliest cursor a page joined with since: the
// next read asks from the earlier of the two, so it answers for every follower (a send
// reported twice reads the same both times).
let cursor: string | null = null;
let floor: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let reading: AbortController | null = null;
let readAgain = false;
let readQueued = false;
let failures = 0;

// Whatever a follower's handler throws is its own bug: reported, and never allowed to stop
// the others or the cadence.
function safely(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    reportError(e);
  }
}

function lower(a: string | null, b: string | null): string | null {
  return a && b ? earlierCursor(a, b) : (a ?? b);
}

function arm(ms: number): void {
  clearTimeout(timer);
  timer = undefined;
  if (!followers.size || document.hidden) {
    return;
  }
  timer = setTimeout(read, ms);
}

function read(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!followers.size) {
    return;
  }
  if (reading) {
    readAgain = true; // someone new, or a page that just acted: once more when this lands
    return;
  }
  const since = lower(cursor, floor);
  floor = null;
  const round = [...followers];
  const c = new AbortController();
  reading = c;
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  api<SendFeedResponse>(`/sends/feed${query}`, { signal: c.signal }).then(
    (res) => {
      if (reading !== c) {
        return; // stopped meanwhile
      }
      reading = null;
      failures = 0;
      cursor = res.cursor;
      for (const f of round) {
        if (followers.has(f)) {
          f.take(res);
        }
      }
      if (readAgain) {
        readAgain = false;
        read();
        return;
      }
      // By the server's clock: its `now` and `read_again_at` are one clock, whatever ours says.
      arm(Math.max(0, res.read_again_at - res.now));
    },
    (err: unknown) => {
      if (reading !== c) {
        return;
      }
      reading = null;
      readAgain = false;
      if (err instanceof ApiError && err.code === "cursor_ahead") {
        // The database is behind every cursor the layer holds (a reset or a restore): no
        // read from them would ever report anything. Every page reads its own sends again
        // and follows from that read.
        const dropped = [...followers];
        for (const f of dropped) {
          leave(f);
        }
        for (const f of dropped) {
          safely(() => f.stale());
        }
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        // A cursor this server no longer reads (one from before a deploy changed its
        // format): start again from what can change on its own.
        cursor = null;
      } else {
        floor = lower(floor, since);
      }
      // A background read that fails stays quiet and is tried again, spaced out: the page
      // loaded from its own read, and the next good read reports everything since.
      failures += 1;
      arm(Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
    },
  );
}

// Followers that join in the same tick (a page wiring several sections) share one read.
function queueRead(): void {
  if (readQueued) {
    return;
  }
  readQueued = true;
  queueMicrotask(() => {
    readQueued = false;
    read();
  });
}

// Hidden, the layer reads nothing (its timer is dropped, and `arm` sets none); shown again,
// it reads at once, since anything may have happened meanwhile.
function onVisibility(): void {
  if (document.hidden) {
    clearTimeout(timer);
    timer = undefined;
  } else {
    read();
  }
}

function join(f: Follower, since: string, signal: AbortSignal): void {
  if (signal.aborted) {
    return;
  }
  followers.add(f);
  floor = lower(floor, since);
  if (followers.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
  }
  signal.addEventListener("abort", () => leave(f), { once: true });
  queueRead();
}

function leave(f: Follower): void {
  followers.delete(f);
  if (followers.size) {
    return;
  }
  clearTimeout(timer);
  timer = undefined;
  reading?.abort();
  reading = null;
  readAgain = false;
  failures = 0;
  cursor = null;
  floor = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

/**
 * Follow every send from the page's own list read, for the life of `signal`. The first
 * feed read asks from that read's cursor, so nothing that changed between the two is
 * missed. `follower.update` gets each later read that found a change, with the stage
 * changes since the page's read (a send it did not list reads as first seen) and the sends
 * removed.
 */
export function followSends(from: ListRead, follower: SendsFollower, signal: AbortSignal): void {
  const seen = new Map<string, SendStage>(
    from.sends.map((s) => [s.id, stageOf({ state: s.status, phase: s.phase })]),
  );
  join(
    {
      take(res) {
        if (!res.sends.length && !res.removed.length) {
          return;
        }
        const changes: StageChange[] = [];
        for (const send of res.sends) {
          const to = stageOf(send);
          const was = seen.get(send.id) ?? null;
          if (was !== to) {
            changes.push({ send, from: was, to });
          }
          seen.set(send.id, to);
        }
        const removed = res.removed.map((r) => r.id);
        for (const id of removed) {
          seen.delete(id);
        }
        safely(() => follower.update({ sends: res.sends, changes, removed }));
      },
      stale: () => follower.stale(),
    },
    from.cursor,
    signal,
  );
}

/**
 * Follow one send from the page's own read of it, for the life of `signal`, whatever its
 * state. `follower.update` gets the send from each later read that found it changed, with
 * its stage change when it moved; `follower.removed` is told once it is deleted.
 */
export function followSend(from: SendRead, follower: SendFollower, signal: AbortSignal): void {
  const id = from.send.id;
  let seen: SendStage = stageOf({ state: from.send.status, phase: from.progress.phase });
  join(
    {
      take(res) {
        if (res.removed.some((r) => r.id === id)) {
          safely(() => follower.removed());
          return;
        }
        const send = res.sends.find((s) => s.id === id);
        if (!send) {
          return;
        }
        const to = stageOf(send);
        const change = to !== seen ? { send, from: seen, to } : null;
        seen = to;
        safely(() => follower.update(send, change));
      },
      stale: () => follower.stale(),
    },
    from.cursor,
    signal,
  );
}

/**
 * Read now, for a page that has just acted on a send (a cancel, a move, a Resolve), so
 * everything following sends catches up at once instead of at the next read. Nothing when
 * nothing follows.
 */
export function readSendsNow(): void {
  if (followers.size) {
    read();
  }
}
