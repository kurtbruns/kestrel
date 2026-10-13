import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import keyedPendingToResolve from "../migrations/0004_keyed_pending_to_resolve.sql?raw";
import { type SendFeedResponse, type SendView, STUCK_THRESHOLD_MS } from "../shared/sends";
import * as sends from "../src/db/sends";
import { LEASE_TTL_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import { clearFakeOutbox } from "../src/providers/fake";
import { nextChangeAt } from "../src/send/feed";
import { resolveStuckSend } from "../src/send/resolve";
import { sweep } from "../src/send/sweep";
import { isWedged } from "../src/send/wedged";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { BatchProvider } from "./support/batching";
import { toNextTick } from "./support/clock";
import { condition, has } from "./support/conditions";
import { addresses, frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { allowErrorLogs } from "./support/log";

// Wedged has one definition (SPEC §12): sending, nothing left to hand off, recipients in
// flight, and the lease released by the run that left them there. The watch, the feed, the
// sweep, and the notifications all read it, and a wedged send is not run again until
// Resolve.

const AUDIENCE = ["ada@example.com", "grace@example.com", "linus@example.org"];

async function progress(id: string): Promise<SendView> {
  const res = await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH });
  return ((await res.json()) as { send: SendView }).send;
}

async function row(id: string) {
  const r = await sends.getSend(env.DB, id);
  if (!r) {
    throw new Error("send not found");
  }
  return r;
}

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a wedged send", () => {
  it("is left alone by the sweep: its rev, its phase, and the feed stay still until Resolve", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new BatchProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await frozenSend(Date.now() - 1000);

    await sweep(env); // fires; the one batch's answer is lost, so its fate is unknown
    const wedged = await row(send.id);
    expect(isWedged(wedged)).toBe(true);
    const list = (await (await SELF.fetch(`${base}/api/sends`, { headers: AUTH })).json()) as {
      cursor: string;
    };
    const requests = provider.requests;

    for (let i = 0; i < 3; i++) {
      await toNextTick(env.DB);
      await sweep(env);
      const now = await row(send.id);
      expect(now.rev).toBe(wedged.rev); // never leased and released again
      expect(now.locked_until).toBeNull();
      const p = await progress(send.id);
      expect([p.phase, has(p, "wedged"), condition(p, "wedged")?.count]).toEqual([
        "needs-attention",
        true,
        3,
      ]);
    }
    expect(provider.requests).toBe(requests); // nothing re-sent (I4)
    const feed = (await (
      await SELF.fetch(`${base}/api/sends/feed?since=${encodeURIComponent(list.cursor)}`, {
        headers: AUTH,
      })
    ).json()) as SendFeedResponse;
    expect(feed.sends).toEqual([]); // nothing changed, so nothing is reported

    await resolveStuckSend(env, send.id, "accepted", "tester");
    expect((await row(send.id)).status).toBe("sent");
  });
});

describe("a batch an earlier release left queued under its key", () => {
  it("goes to Resolve once migrated, rather than holding the send open and silent (SPEC §12)", async () => {
    allowErrorLogs("send.wedged");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(providers, "getProvider").mockReturnValue(new BatchProvider());
    await seedConfirmed(AUDIENCE);
    const send = await frozenSend(Date.now() - 1000);
    // As 1.7.0 left a batch whose answer was lost on Resend: two rows back in the queue
    // under the key they were sent with, waiting to be re-sent under it.
    const now = Date.now();
    const lease = (await sends.acquireLease(env.DB, send.id, now, 60_000))!;
    await sends.resolveAudience(env.DB, send.id, now);
    await env.DB.prepare(
      `UPDATE deliveries SET dispatch_key = 'k-old', keyed_at = ? WHERE send_id = ? AND email IN ('ada@example.com', 'grace@example.com')`,
    )
      .bind(now, send.id)
      .run();
    await sends.releaseLease(env.DB, send.id, lease);
    await sends.recomputeSendCounters(env.DB, send.id);

    for (const statement of keyedPendingToResolve
      .split(";")
      .filter((q) => q.trim() && !/^\s*(--[^\n]*\n?\s*)*$/.test(q))) {
      await env.DB.prepare(statement).run();
    }

    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 2, pending: 1 });
    expect([(await row(send.id)).c_pending, (await row(send.id)).c_in_flight]).toEqual([1, 2]);
    await toNextTick(env.DB);
    await sweep(env); // the fresh row goes out; the migrated batch is never re-sent
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 2, accepted: 1 });
    expect(isWedged(await row(send.id))).toBe(true);
    const resolved = await resolveStuckSend(env, send.id, "unsent", "tester");
    expect(resolved.completed).toBe(true);
  });
});

describe("a wedged send a receipt with no provider id reaches", () => {
  it("keeps every unknown recipient, its count, and Resolve: a receipt that cannot name its message never settles one", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged", "send.stuck");
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new BatchProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await frozenSend(Date.now() - 1000);
    await sweep(env); // the one batch's answer is lost: three recipients of unknown fate
    const wedged = await row(send.id);
    expect(isWedged(wedged)).toBe(true);

    // A receipt for each address, carrying the address but no provider id. The address's
    // most recent delivery is the unknown one, but nothing says the receipt is for it.
    await applyDeliveryEvents(
      env.DB,
      AUDIENCE.map((email) => ({ type: "delivered" as const, email })),
    );

    const after = await row(send.id);
    expect(after.c_in_flight).toBe(3);
    expect(after.rev).toBe(wedged.rev); // the record did not move
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND event IS NOT NULL",
    )
      .bind(send.id)
      .first<number>("n");
    expect(events).toBe(0);

    // Past the stuck threshold the send still reads wedged, with its count and the control
    // that settles it beside the stuck flag, and the sweep still leaves it alone.
    vi.setSystemTime(Date.now() + STUCK_THRESHOLD_MS + 60_000);
    await sweep(env);
    expect((await row(send.id)).rev).toBe(wedged.rev);
    const p = await progress(send.id);
    expect([p.phase, has(p, "stuck"), condition(p, "wedged")?.count]).toEqual([
      "needs-attention",
      true,
      3,
    ]);
    expect(p.actions.map((a) => a.name)).toEqual(["resolve"]);

    await resolveStuckSend(env, send.id, "accepted", "tester");
    expect((await row(send.id)).status).toBe("sent");
  });
});

describe("the one definition", () => {
  it("reads the same in the watch's predicate and in the SQL the feed, sweep, and notifications use", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await frozenSend(Date.now() + 3_600_000);
    const now = Date.now();
    const cases = [];
    for (const status of ["scheduled", "sending", "sent"]) {
      for (const c_pending of [0, 2]) {
        for (const c_in_flight of [0, 3]) {
          for (const locked_until of [null, now - 1000, now + 60_000]) {
            cases.push({ status, c_pending, c_in_flight, locked_until });
          }
        }
      }
    }
    for (const c of cases) {
      await env.DB.prepare(
        "UPDATE sends SET status = ?, c_pending = ?, c_in_flight = ?, locked_until = ? WHERE id = ?",
      )
        .bind(c.status, c.c_pending, c.c_in_flight, c.locked_until, send.id)
        .run();
      const sql = await env.DB.prepare(`SELECT ${sends.WEDGED_SEND} AS w FROM sends WHERE id = ?`)
        .bind(send.id)
        .first<number>("w");
      expect([c, sql === 1]).toEqual([c, isWedged(c)]);
    }
    expect(cases.filter(isWedged)).toHaveLength(1);
  });
});

describe("the pace around a wedge and a cut-off run", () => {
  const NOW = 1_800_000_000_000;
  const inFlight = {
    status: "sending" as const,
    fire_at: NOW - 600_000,
    started_at: NOW - 60_000,
    c_pending: 0,
    c_in_flight: 1,
  };

  it("never hurries for a wedged send, even one still carrying a past halt", () => {
    expect(
      nextChangeAt({ ...inFlight, locked_until: null, halt_retry_at: NOW - 300_000 }, NOW),
    ).toBe(NOW - 60_000 + STUCK_THRESHOLD_MS);
  });

  it("waits for the retry of a halted send whose run was cut off, rather than reading it as moving", () => {
    const retry = NOW + 10 * 60_000;
    expect(
      nextChangeAt(
        { ...inFlight, c_pending: 3, locked_until: NOW - 1_000, halt_retry_at: retry },
        NOW,
      ),
    ).toBe(retry - 30_000);
    // With no halt, a cut-off run's expired lease is taken up at the next tick.
    expect(nextChangeAt({ ...inFlight, locked_until: NOW - 1_000, halt_retry_at: null }, NOW)).toBe(
      NOW,
    );
  });
});

describe("a database that refuses every query partway through a send", () => {
  // As D1 on Workers Free does once a day's written rows are spent (until midnight UTC): the
  // provider has taken a batch, and the write that would record its answer is refused.
  function refusingDb(db: D1Database, refusing: { on: boolean }): D1Database {
    const refuse = () => {
      if (refusing.on) {
        throw new Error("D1_ERROR: the database refused the query");
      }
    };
    const inner = new WeakMap<object, D1PreparedStatement>();
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
      const guarded = {
        bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
        first: (column?: string) => {
          refuse();
          return column === undefined ? stmt.first() : stmt.first(column);
        },
        run: () => {
          refuse();
          return stmt.run();
        },
        all: () => {
          refuse();
          return stmt.all();
        },
        raw: () => {
          refuse();
          return stmt.raw();
        },
      };
      inner.set(guarded, stmt);
      return guarded as unknown as D1PreparedStatement;
    };
    return {
      prepare: (sql: string) => wrap(db.prepare(sql)),
      batch: (statements: D1PreparedStatement[]) => {
        refuse();
        return db.batch(statements.map((s) => inner.get(s) ?? s));
      },
      exec: (sql: string) => {
        refuse();
        return db.exec(sql);
      },
    } as unknown as D1Database;
  }

  it("leaves the batch it couldn't record waiting for Resolve, and mails no one twice (I4)", async () => {
    allowErrorLogs("send.error", "sweep.error", "send.wedged");
    vi.useFakeTimers({ toFake: ["Date"] });
    const refusing = { on: false };
    // Three groups of ten recipients, in batches of two: the first is recorded, the database
    // refuses partway through the second, and the third is still to go.
    const audience = addresses(30);
    class RefusedMidSend extends BatchProvider {
      override readonly maxBatch: number = 2;
      override async sendBatch(...args: Parameters<BatchProvider["sendBatch"]>) {
        const nth = this.requests + 1; // batches go out together, so count before awaiting
        const answer = await super.sendBatch(...args);
        if (nth === 7) {
          refusing.on = true; // the provider took the batch; recording its answer is refused
        }
        return answer;
      }
    }
    const provider = new RefusedMidSend();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(audience);
    const send = await frozenSend(Date.now() - 1000);

    await sweep({ ...env, DB: refusingDb(env.DB, refusing) }).catch(() => undefined);
    expect(provider.requests).toBe(10); // the second group went out whole before its answers

    // The next day: the database answers again, and the run that was cut off has lost its lease.
    refusing.on = false;
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + LEASE_TTL_MS);
      await toNextTick(env.DB);
      await sweep(env);
    }

    // The third group went out once the database answered; no one was mailed twice.
    expect(provider.requests).toBe(15);
    expect(audience.every((e) => provider.timesMailed(e) === 1)).toBe(true);
    const p = await progress(send.id);
    expect([p.status, p.phase, condition(p, "wedged")?.count]).toEqual([
      "sending",
      "needs-attention",
      10,
    ]);
    expect(p.counts.accepted).toBe(20);
    const requests = provider.requests;
    await sweep(env);
    expect(provider.requests).toBe(requests);
  });
});
