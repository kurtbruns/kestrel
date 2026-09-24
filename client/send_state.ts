// The send-state layer: one shared, paced read of the sends that can change on their own
// (GET /sends/live), which pages follow instead of polling, so every page tells the same
// story about a send and keeps up with it at one cadence (docs/DESIGN.md §9).

import type { LiveSend, LiveSendsResponse, SendPhase, SendStatus } from "../shared/sends";
import { api } from "./api";

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

/** What a follower of every live send gets from each read. */
export interface SendsUpdate {
  /** Every send that can still change on its own, soonest fire first. */
  sends: LiveSend[];
  /** The sends whose stage moved since this follower's last update, those that left `sends` included. */
  changes: StageChange[];
}

// While a send is due or sending, the sweep can act on it at any minute's tick, and a page
// shows what it did within this.
const FOLLOW_MS = 3000;

// While sends are only settling, the pace their receipts arrive at, by how long ago the
// youngest one finished dispatch: most land in the first minutes, stragglers over the hour
// the server keeps listing it (SETTLE_FOLLOW_MS).
const SETTLE_PACE: readonly { within: number; every: number }[] = [
  { within: 2 * 60_000, every: 3000 },
  { within: 10 * 60_000, every: 15_000 },
  { within: Number.POSITIVE_INFINITY, every: 60_000 },
];

// A wake for a fire time lands this long after it, so the server's clock has passed it.
const WAKE_SLACK_MS = 1000;

// The longest timer armed at once; a wake further out re-arms without reading.
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

// A failed read is tried again after this, doubling up to the cap while it keeps failing.
const RETRY_MS = 3000;
const RETRY_MAX_MS = 60_000;

/**
 * How long after `res` to read again, by the server's clock, or null when nothing can
 * change on its own and nothing is coming due: every 3 s while a send is due or sending,
 * at the settling pace while one is only settling, and otherwise once, when the next
 * scheduled send comes due.
 */
export function nextReadIn(res: LiveSendsResponse): number | null {
  const stages = res.sends.map(stageOf);
  let wait: number | null = null;
  if (stages.some((s) => s === "due" || s === "sending")) {
    wait = FOLLOW_MS;
  } else {
    const ages = res.sends
      .filter((s) => stageOf(s) === "sent")
      .map((s) => res.now - (s.completed_at ?? res.now));
    if (ages.length) {
      const youngest = Math.min(...ages);
      wait = SETTLE_PACE.find((p) => youngest < p.within)?.every ?? null;
    }
  }
  if (res.next_fire_at !== null) {
    const due = Math.max(0, res.next_fire_at - res.now) + WAKE_SLACK_MS;
    wait = wait === null ? due : Math.min(wait, due);
  }
  return wait;
}

/** One page's interest: every live send, or one send by id. */
interface Follower {
  /** The ids it needs named in the next read, to learn where each went. */
  wants(): string[];
  /** Take a read it was part of. */
  take(res: LiveSendsResponse): void;
  /** Its first read failed: the page shows the error, and the follower is dropped. */
  fail(err: unknown): void;
}

const followers = new Set<Follower>();
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

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function arm(ms: number): void {
  clearTimeout(timer);
  timer = undefined;
  if (!followers.size || document.hidden) {
    return;
  }
  timer =
    ms > MAX_TIMER_MS
      ? setTimeout(() => arm(ms - MAX_TIMER_MS), MAX_TIMER_MS)
      : setTimeout(read, ms);
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
  const round = [...followers];
  const ids = [...new Set(round.flatMap((f) => f.wants()))];
  const query = ids.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
  const c = new AbortController();
  reading = c;
  api<LiveSendsResponse>(`/sends/live${query}`, { signal: c.signal }).then(
    (res) => {
      if (reading !== c) {
        return; // stopped meanwhile
      }
      reading = null;
      failures = 0;
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
      const wait = nextReadIn(res);
      if (wait !== null) {
        arm(wait);
      }
    },
    (err: unknown) => {
      if (reading !== c) {
        return;
      }
      reading = null;
      readAgain = false;
      // A background read that fails stays quiet and is tried again, spaced out; only a
      // follower still waiting on its first read hears of it.
      failures += 1;
      const retry = Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      for (const f of round) {
        if (followers.has(f)) {
          f.fail(err);
        }
      }
      arm(retry);
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

function join(f: Follower, signal: AbortSignal): void {
  followers.add(f);
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
  document.removeEventListener("visibilitychange", onVisibility);
}

/** Every send a read reports, the live ones and the named ones, by id. */
function byId(res: LiveSendsResponse): Map<string, LiveSend> {
  return new Map([...res.sends, ...res.named].map((s) => [s.id, s]));
}

/**
 * Follow every send that can still change on its own, for the life of `signal`. Resolves
 * with the first update, which a page reads beside its own and paints from; `onUpdate` then
 * gets each later one, with the stage changes since the one before. Rejects if that first
 * read fails, as any read a page loads with would.
 */
export function followSends(
  onUpdate: (update: SendsUpdate) => void,
  signal: AbortSignal,
): Promise<SendsUpdate> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let seen: Map<string, SendStage> | null = null;
    const f: Follower = {
      wants: () => (seen ? [...seen.keys()] : []),
      take(res) {
        const all = byId(res);
        const changes: StageChange[] = [];
        if (seen) {
          for (const [id, from] of seen) {
            const send = all.get(id);
            const to = send && stageOf(send);
            if (send && to && to !== from) {
              changes.push({ send, from, to });
            }
          }
          for (const send of res.sends) {
            if (!seen.has(send.id)) {
              changes.push({ send, from: null, to: stageOf(send) });
            }
          }
        }
        const first = seen === null;
        seen = new Map(res.sends.map((s) => [s.id, stageOf(s)]));
        const update = { sends: res.sends, changes };
        if (first) {
          resolve(update);
        } else {
          safely(() => onUpdate(update));
        }
      },
      fail(err) {
        if (seen === null) {
          leave(f);
          reject(err);
        }
      },
    };
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    join(f, signal);
  });
}

/**
 * Follow one send, for the life of `signal`, whatever its state: it is named in every read.
 * Resolves with the send as it stands (null when there is no such send); `onUpdate` then
 * gets it from each later read, with its stage change when it moved. The reads come at the
 * layer's one cadence, so a send far from its fire time is read again only when something
 * else is live, when a fire time comes due, or when the tab is shown again.
 */
export function followSend(
  id: string,
  onUpdate: (send: LiveSend, change: StageChange | null) => void,
  signal: AbortSignal,
): Promise<LiveSend | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let first = true;
    let seen: SendStage | null = null;
    const f: Follower = {
      wants: () => [id],
      take(res) {
        const send = byId(res).get(id) ?? null;
        const to = send && stageOf(send);
        if (first) {
          first = false;
          seen = to;
          resolve(send);
          return;
        }
        if (send && to) {
          const change = to !== seen ? { send, from: seen, to } : null;
          seen = to;
          safely(() => onUpdate(send, change));
        }
      },
      fail(err) {
        if (first) {
          leave(f);
          reject(err);
        }
      },
    };
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    join(f, signal);
  });
}

/**
 * Read now, for a page that has just acted on a send (a cancel, a move, a Resolve), so
 * everything following sends catches up at once instead of at the next tick. Nothing when
 * nothing follows.
 */
export function readSendsNow(): void {
  if (followers.size) {
    read();
  }
}
