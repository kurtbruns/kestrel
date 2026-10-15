import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { STUCK_THRESHOLD_MS } from "../shared/sends";
import * as notifications from "../src/db/notifications";
import * as sends from "../src/db/sends";
import { LEASE_TTL_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import { idleSince, isStuck } from "../src/send/stuck";
import { sweep } from "../src/send/sweep";
import { BatchProvider } from "./support/batching";
import { has } from "./support/conditions";
import { addresses, dueSend, resetDatabase, seedConfirmed, setRow, tick } from "./support/fixtures";
import { allowErrorLogs, logged } from "./support/log";
import { viewOf } from "./support/view";

// In flight too long means stopped, not slow (SPEC §12): a send that has handed off no one
// for the stuck threshold with nothing else to explain it. A send that is handing off is
// never flagged, however long it takes; a halt explains the wait until its retry, and a
// wedged send waits for Resolve.

const MIN = 60_000;

let errors: MockInstance;
let infos: MockInstance;
let transport: BatchProvider;

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
  errors = vi.spyOn(console, "error");
  infos = vi.spyOn(console, "log");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stuckLines = () => logged(errors).filter((l) => l.event === "send.stuck");

async function notified(sendId: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind, episode FROM notifications WHERE send_id = ? ORDER BY created_at",
  )
    .bind(sendId)
    .all<{ kind: string; episode: number }>();
  return results;
}

describe("a long send that keeps handing off", () => {
  it("is never flagged, told, or logged as stuck, however long ago it started", async () => {
    await seedConfirmed(addresses(1000)); // more than one free-plan tick delivers
    const send = await dueSend();
    await tick();
    // As if it had been going out at a slow provider rate for two hours.
    await setRow(send.id, { started_at: Date.now() - 4 * STUCK_THRESHOLD_MS });
    const before = (await sends.getSend(env.DB, send.id))!.c_accepted;
    await tick();

    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.c_accepted).toBeGreaterThan(before);
    expect(row.progress_at).toBe(Date.now());
    expect(has(viewOf(row, "ses", false, Date.now() + STUCK_THRESHOLD_MS), "stuck")).toBe(false);
    expect(stuckLines()).toEqual([]);
    expect(await notified(send.id)).toEqual([]);
    expect(logged(infos).at(-1)).toMatchObject({
      event: "sweep.tick",
      stuck: 0,
    });
  });
});

describe("a send nothing is moving", () => {
  it("is flagged, told once, and logged every tick once it has handed off no one for the threshold", async () => {
    allowErrorLogs("send.error", "send.stuck");
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    // Every run fails before it hands anyone off.
    const failing = vi.spyOn(sends, "fetchDeliveryWork").mockRejectedValue(new Error("boom"));
    await tick();
    const started = (await sends.getSend(env.DB, send.id))!.started_at!;

    vi.setSystemTime(started + STUCK_THRESHOLD_MS);
    await sweep(env);
    expect(stuckLines()).toEqual([]); // the threshold itself is not past it
    expect(
      has(viewOf((await sends.getSend(env.DB, send.id))!, "ses", false, Date.now()), "stuck"),
    ).toBe(false);

    vi.setSystemTime(started + STUCK_THRESHOLD_MS + MIN);
    await sweep(env);
    await tick();
    const row = (await sends.getSend(env.DB, send.id))!;
    const prog = viewOf(row, "ses", false, Date.now());
    expect(has(prog, "stuck")).toBe(true);
    expect(prog.dispatch.eta_ms).toBeNull(); // no finish promised for a send that sits still
    expect(prog.conditions.find((c) => c.kind === "stuck")).toMatchObject({
      severity: "warn",
      since: started + STUCK_THRESHOLD_MS,
    });
    expect(stuckLines()).toHaveLength(2);
    expect(stuckLines()[0]).toMatchObject({ level: "error", sendId: send.id, idleSince: started });
    expect(await notified(send.id)).toEqual([{ kind: "stuck", episode: started }]);

    // It moves again once the failed run's lease runs out: done, and nothing more is told.
    failing.mockRestore();
    vi.setSystemTime(Date.now() + LEASE_TTL_MS);
    await sweep(env);
    const moved = (await sends.getSend(env.DB, send.id))!;
    expect(moved.status).toBe("sent");
    expect(await notified(send.id)).toEqual([
      { kind: "stuck", episode: started },
      { kind: "finished", episode: 0 },
    ]);
  });

  it("is told again for a second stall after it moved, each stall once", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    const now = Date.now();
    const stalled = now - STUCK_THRESHOLD_MS - MIN;
    await setRow(send.id, {
      status: "sending",
      started_at: stalled - STUCK_THRESHOLD_MS,
      progress_at: stalled,
      c_pending: 2,
    });
    await notifications.recordNotifications(env.DB, now);
    await notifications.recordNotifications(env.DB, now);
    // It handed someone off, then stopped again.
    const later = now + 5 * MIN;
    await setRow(send.id, { progress_at: later - STUCK_THRESHOLD_MS - MIN });
    await notifications.recordNotifications(env.DB, later);

    expect(await notified(send.id)).toEqual([
      { kind: "stuck", episode: stalled },
      { kind: "stuck", episode: later - STUCK_THRESHOLD_MS - MIN },
    ]);
  });
});

describe("a halted send", () => {
  it("is explained by its halt until its retry, and stuck only once the retry is long overdue", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    const now = Date.now();
    await setRow(send.id, {
      status: "sending",
      started_at: now - 3 * STUCK_THRESHOLD_MS,
      progress_at: now - 2 * STUCK_THRESHOLD_MS,
      c_pending: 2,
      halt_reason: "unavailable",
      halt_cause: "outage",
      halt_error: "503",
      halted_at: now - 2 * STUCK_THRESHOLD_MS,
      halt_retries: 6,
      halt_retry_at: now + 20 * MIN,
    });
    const row = (await sends.getSend(env.DB, send.id))!;
    expect(idleSince(row)).toBe(now + 20 * MIN);
    expect(isStuck(row, now + 20 * MIN + STUCK_THRESHOLD_MS)).toBe(false);
    expect(isStuck(row, now + 20 * MIN + STUCK_THRESHOLD_MS + 1)).toBe(true);
    await notifications.recordNotifications(env.DB, now);
    expect(await notified(send.id)).toEqual([]);
  });
});

describe("the one definition", () => {
  it("reads the same in the watch's predicate and in the SQL the feed, sweep, and notifications use", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend();
    const now = Date.now();
    const past = now - STUCK_THRESHOLD_MS - MIN;
    const recent = now - MIN;
    const cases = [];
    for (const status of ["scheduled", "sending", "sent"]) {
      for (const started_at of [null, past]) {
        for (const progress_at of [null, past, recent]) {
          for (const halt_retry_at of [null, past, now + MIN]) {
            // Every side of the wedge: work left or not, rows in flight or not, a run
            // holding the lease or not.
            for (const c_pending of [0, 2]) {
              for (const c_in_flight of [0, 2]) {
                for (const locked_until of [null, now + MIN]) {
                  cases.push({
                    status,
                    started_at,
                    progress_at,
                    halt_retry_at,
                    c_pending,
                    c_in_flight,
                    locked_until,
                  });
                }
              }
            }
          }
        }
      }
    }
    for (const c of cases) {
      await setRow(send.id, c);
      const sql = await env.DB.prepare(
        `SELECT ${sends.stuckSendSql("?")} AS s, ${sends.SEND_IDLE_SINCE} AS idle FROM sends WHERE id = ?`,
      )
        .bind(now - STUCK_THRESHOLD_MS, send.id)
        .first<{ s: number; idle: number | null }>();
      expect([c, sql?.s === 1]).toEqual([c, isStuck(c, now)]);
      if (idleSince(c) !== null) {
        expect([c, sql?.idle]).toEqual([c, idleSince(c)]);
      }
    }
    expect(cases.filter((c) => isStuck(c, now)).length).toBeGreaterThan(0);
  });
});
