import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import {
  ConfigError,
  DEFAULT_SES_MAX_SEND_RATE,
  DEFAULT_SUBREQUEST_BUDGET,
  getConfig,
  MIN_SUBREQUEST_BUDGET,
} from "../src/env";
import { HALT_BACKOFF_MS, LEASE_TTL_MS } from "../src/lib/time";
import { NOTIFY_RESERVE } from "../src/notify/notify";
import * as providers from "../src/providers";
import { Budget, D1_QUERY_LIMIT } from "../src/send/budget";
import { MIN_RUN_COST, runSend } from "../src/send/loop";
import { SendWindow } from "../src/send/pace";
import { resolveStuckSend } from "../src/send/resolve";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";
import { guardD1 } from "./support/d1_guard";
import { ResendLikeProvider } from "./support/resend_like";

/** SES-shaped: one recipient a request and no idempotency key. */
class SesLikeProvider extends ResendLikeProvider {
  override readonly maxBatch: number = 1;
  override readonly idempotentRetry: boolean = false;
  override readonly idempotencyWindowMs: number | undefined = undefined;
}

const addresses = (n: number, tag = "r") =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(3, "0")}@example.com`);

async function seedConfirmed(emails: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at)
     SELECT 'id-' || value, value, 'confirmed', 'cfm-' || value, 'uns-' || value, ?, ? FROM json_each(?)`,
  )
    .bind(now, now, JSON.stringify(emails))
    .run();
}

async function dueSend() {
  const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "hi" }, "test");
  return freeze(env, getConfig(env), post, Date.now() - 1000);
}

/** The test env with its D1 held to the 100-bind cap and counted. */
function guarded() {
  const guard = guardD1(env.DB);
  return { guard, env: { ...env, DB: guard.db } as AppEnv };
}

/** One sweep tick, on the next minute or the next halt retry, whichever is later. */
async function tick(): Promise<void> {
  await toNextTick(env.DB);
  await sweep(env);
}

let resend: ResendLikeProvider;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
  // Only Date is faked, so `tick` can move the clock past a halt's backoff.
  vi.useFakeTimers({ toFake: ["Date"] });
  resend = new ResendLikeProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(resend);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("D1's 100-parameter cap", () => {
  it("a Resend-shaped send of full 100-recipient batches binds under the cap", async () => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();
    const { env: capped } = guarded();

    const result = await runSend(capped, send.id, new Budget(1000));

    expect(result.finished).toBe(true);
    expect(result.accepted).toBe(250);
    expect(resend.requests).toBe(3);
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
  });

  it("the re-make guard binds a fixed number of parameters however many sends it acknowledges", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `s-${i}`);
    const guard = sends.remakeGuard(0, Date.now(), ids);
    const { guard: d1 } = guarded();
    const row = await d1.db
      .prepare(`SELECT 1 AS ok WHERE ${guard.sql}`)
      .bind(...guard.binds)
      .first<{ ok: number }>();
    expect(row?.ok).toBe(1);
  });
});

describe("the per-invocation budget", () => {
  it("a send larger than one invocation's budget completes across ticks, each recipient accepted once", async () => {
    const emails = addresses(450);
    await seedConfirmed(emails);
    const send = await dueSend();
    const { guard, env: capped } = guarded();
    const limit = getConfig(capped).subrequestBudget;
    expect(limit).toBe(50); // the Workers Free default

    let ticks = 0;
    while ((await sends.getSend(env.DB, send.id))!.status !== "sent" && ticks < 20) {
      const statementsBefore = guard.statements;
      const requestsBefore = resend.requests;
      await sweep(capped);
      ticks += 1;
      const spent = guard.statements - statementsBefore + (resend.requests - requestsBefore);
      expect(spent).toBeLessThanOrEqual(limit);
    }

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(ticks).toBeGreaterThan(1);
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 450 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
  });
});

describe("SUBREQUEST_BUDGET", () => {
  const budgetFor = (v: string | undefined) =>
    getConfig({ ...env, SUBREQUEST_BUDGET: v } as AppEnv).subrequestBudget;

  it("defaults to the Workers Free limit, takes a raise, and is never set too low to send", () => {
    expect(budgetFor(undefined)).toBe(DEFAULT_SUBREQUEST_BUDGET);
    expect(budgetFor("1000")).toBe(1000);
    expect(budgetFor("10")).toBe(MIN_SUBREQUEST_BUDGET);
    // A typo is refused, never taken for the default.
    expect(() => budgetFor("not a number")).toThrow(ConfigError);
    expect(() => budgetFor("0")).toThrow(/SUBREQUEST_BUDGET/);
    // The floor has to cover a tick's own queries (the anomaly checks, due and resumable
    // sends) and its notification reserve, plus one run's opening, one batch, and its close.
    expect(MIN_SUBREQUEST_BUDGET).toBeGreaterThanOrEqual(MIN_RUN_COST + 4 + NOTIFY_RESERVE);
  });
});

describe("a Resend batch interrupted after acceptance", () => {
  // The batch was accepted but its answer never recorded: either the response was lost
  // (the request throws), or the run was cut off while recording it (the write throws,
  // as hitting the invocation cap does). Either way its rows' fate is unknown to us.
  const interruptions = {
    "its answer is lost": () => {
      resend.loseAnswers = 1;
    },
    "the run is cut off while recording it": () => {
      const real = sends.settleDeliveries;
      let cut = false;
      vi.spyOn(sends, "settleDeliveries").mockImplementation(async (...args) => {
        if (!cut && args[3] === "dispatched") {
          cut = true;
          throw new Error("Too many API requests by single worker invocation");
        }
        return real(...args);
      });
    },
  };

  for (const [name, interrupt] of Object.entries(interruptions)) {
    it(`re-mails nobody when ${name} and the batches are composed differently on resume`, async () => {
      const emails = addresses(150);
      await seedConfirmed(emails);
      const send = await dueSend();

      interrupt();
      await tick();
      expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
      expect(resend.mailed.length).toBe(100); // the first batch went out

      // In between, one recipient of the handed-off batch and one not yet handed off
      // unsubscribe, so any batch re-made from the queue would be composed differently.
      const { results } = await env.DB.prepare(
        "SELECT email FROM deliveries WHERE send_id = ? AND dispatch_key IS NOT NULL ORDER BY email",
      )
        .bind(send.id)
        .all<{ email: string }>();
      expect(results.length).toBe(100);
      const handedOff = results[0]!.email;
      const notYet = emails.find((e) => !results.some((r) => r.email === e))!;
      await env.DB.prepare(
        "UPDATE subscribers SET status = 'unsubscribed' WHERE email IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify([handedOff, notYet]))
        .run();
      // A run cut off mid-write never released its lease; let it lapse.
      await env.DB.prepare("UPDATE sends SET locked_until = ? WHERE id = ?")
        .bind(Date.now() - 1, send.id)
        .run();

      await tick();

      expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
      expect(emails.every((e) => resend.timesMailed(e) <= 1)).toBe(true);
      expect(resend.timesMailed(handedOff)).toBe(1); // mailed once, before the unsubscribe
      expect(resend.timesMailed(notYet)).toBe(0); // I2: not yet handed off, so skipped
      expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 149, skipped: 1 });
    });
  }
});

describe("a retryable answer to a handed-off batch", () => {
  it("keeps the batch's key, so a 429 on the re-send doesn't re-mail it under a new one", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();

    resend.loseAnswers = 1; // accepted, answer lost
    await tick();
    resend.rateLimit = 1; // the re-send is rate-limited
    await tick();
    await tick(); // re-sent again under the same key: Resend returns its first answer

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
  });

  it("on a provider switched to one without idempotency, goes to Resolve instead of stalling", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    resend.loseAnswers = 1;
    await tick();

    // The operator moves the deployment to a provider that can't dedupe a re-send.
    const plain = new (class extends ResendLikeProvider {
      override readonly idempotentRetry: boolean = false;
    })();
    vi.mocked(providers.getProvider).mockReturnValue(plain);
    await tick();

    expect(plain.requests).toBe(0); // never re-sent blind
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 3 });
    const resolved = await resolveStuckSend(env, send.id, "accepted", "op@example.com");
    expect(resolved.completed).toBe(true);
  });

  it("on a provider without idempotency, leaves in-flight batches untouched and keeps delivering", async () => {
    // SES-shaped: one recipient per request, no idempotency, so a request with no answer
    // leaves its recipient in flight for Resolve. That must neither stall the rest of
    // the send nor refresh the row, which would hide it from the stale-delivery flag.
    const emails = addresses(4);
    await seedConfirmed(emails);
    const send = await dueSend();
    const ses = new (class extends ResendLikeProvider {
      override readonly maxBatch: number = 1;
      override readonly idempotentRetry: boolean = false;
    })();
    vi.mocked(providers.getProvider).mockReturnValue(ses);

    ses.loseAnswers = 1;
    await tick();
    const wedged = await env.DB.prepare(
      "SELECT id, updated_at FROM deliveries WHERE send_id = ? AND status = 'dispatched'",
    )
      .bind(send.id)
      .first<{ id: string; updated_at: number }>();
    expect(wedged).not.toBeNull();

    await tick();
    await tick();

    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3, dispatched: 1 });
    expect(emails.every((e) => ses.timesMailed(e) === 1)).toBe(true);
    const after = await env.DB.prepare("SELECT updated_at FROM deliveries WHERE id = ?")
      .bind(wedged!.id)
      .first<{ updated_at: number }>();
    expect(after!.updated_at).toBe(wedged!.updated_at);
  });
});

describe("lease ownership", () => {
  it("a run whose lease passed to a successor can't release, renew, complete, or hand off", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    const now = Date.now();
    const stale = (await sends.acquireLease(env.DB, send.id, now, LEASE_TTL_MS))!;
    await sends.resolveAudience(env.DB, send.id, now);
    // The stale run stalls past its lease, and the next tick takes the send over.
    await env.DB.prepare("UPDATE sends SET locked_until = ? WHERE id = ?")
      .bind(now - 1, send.id)
      .run();
    const successor = await sends.acquireLease(env.DB, send.id, now, LEASE_TTL_MS);
    expect(successor).not.toBeNull();
    expect(successor).not.toBe(stale);

    await sends.releaseLease(env.DB, send.id, stale);
    expect(await sends.renewLease(env.DB, send.id, stale, now + LEASE_TTL_MS)).toBe(false);
    const ids = await sends.pendingDeliveryIds(env.DB, send.id, 10);
    expect(
      await sends.dispatchFresh(env.DB, send.id, stale, [{ key: "k-stale", ids }], now),
    ).toEqual([]);
    await sends.settleDeliveries(
      env.DB,
      send.id,
      stale,
      "pending",
      ids.map((id) => ({ id, status: "skipped" })),
      now,
    );
    await sends.completeSend(env.DB, send.id, send.post_id, now, stale);

    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.status).toBe("sending");
    expect(row.locked_until).toBe(now + LEASE_TTL_MS); // the successor's lease, untouched
    expect(row.c_pending).toBe(2);
    expect(await sends.openDeliveryCount(env.DB, send.id)).toBe(2);
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("scheduled");

    // The successor still owns the send and finishes it.
    const result = await runSend(env, send.id);
    expect(result.leased).toBe(false); // its lease is live, so a third run stays out
    expect(await sends.renewLease(env.DB, send.id, successor!, now + LEASE_TTL_MS)).toBe(true);
  });

  it("a stale run can't re-send, return, or record the successor's in-flight batch", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    const now = Date.now();
    const stale = (await sends.acquireLease(env.DB, send.id, now, LEASE_TTL_MS))!;
    await sends.resolveAudience(env.DB, send.id, now);
    await env.DB.prepare("UPDATE sends SET locked_until = ? WHERE id = ?")
      .bind(now - 1, send.id)
      .run();
    const successor = (await sends.acquireLease(env.DB, send.id, now, LEASE_TTL_MS))!;
    const ids = await sends.pendingDeliveryIds(env.DB, send.id, 10);
    expect(
      await sends.dispatchFresh(env.DB, send.id, successor, [{ key: "k1", ids }], now),
    ).toHaveLength(2);

    expect(await sends.redispatch(env.DB, send.id, stale, "k1", now)).toEqual([]);
    await sends.holdBatch(
      env.DB,
      send.id,
      stale,
      [{ key: "k1", keepKey: true }],
      { reason: "unavailable", cause: "outage", error: "stale" },
      HALT_BACKOFF_MS.unavailable,
      now,
    );
    await sends.settleDeliveries(
      env.DB,
      send.id,
      stale,
      "dispatched",
      ids.map((id) => ({ id, status: "unsent", error: "stale" })),
      now,
    );

    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.c_in_flight).toBe(2);
    expect(row.c_pending).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 2 });
    expect(await sends.unansweredDispatchKeys(env.DB, send.id)).toEqual([
      { key: "k1", keyedAt: now },
    ]);
    expect(row.halt_reason).toBeNull(); // nor record a halt on the successor's send
  });
});

describe("the budget's two meters", () => {
  it("holds D1 statements to Cloudflare's cap however high the subrequest limit is", () => {
    const b = new Budget(10_000);
    expect(b.queryLimit).toBe(D1_QUERY_LIMIT);
    b.query(D1_QUERY_LIMIT - 5);
    expect(b.affords(5)).toBe(true);
    expect(b.affords(6)).toBe(false);
    // Requests still fit under the subrequest limit once D1 is spent.
    expect(b.affords(0, 8_000)).toBe(true);
  });

  it("counts D1 statements and requests together against the subrequest limit", () => {
    const b = new Budget(50);
    expect(b.queryLimit).toBe(50);
    b.query(30);
    b.request(15);
    expect(b.left).toBe(5);
    expect(b.queriesLeft).toBe(5);
    expect(b.affords(3, 2)).toBe(true);
    expect(b.affords(3, 3)).toBe(false);
  });
});

describe("a one-recipient provider's groups", () => {
  let ses: SesLikeProvider;

  beforeEach(() => {
    ses = new SesLikeProvider();
    vi.mocked(providers.getProvider).mockReturnValue(ses);
  });

  it("shares the D1 writes, so a recipient costs about half a statement", async () => {
    const emails = addresses(3000);
    await seedConfirmed(emails);
    const send = await dueSend();
    const { guard, env: capped } = guarded();

    // Workers Paid: 10,000 subrequests, of which D1 may be 1,000.
    const budget = new Budget(10_000);
    const result = await runSend(capped, send.id, budget);

    expect(guard.statements).toBeLessThanOrEqual(D1_QUERY_LIMIT);
    expect(result.accepted).toBeGreaterThan(1500);
    expect(guard.statements / result.accepted).toBeLessThan(0.6);
    expect(ses.requests).toBe(result.accepted);
    expect(emails.every((e) => ses.timesMailed(e) <= 1)).toBe(true);
  });

  it("still sends on the Workers Free budget, shrinking a group to fit", async () => {
    const emails = addresses(60);
    await seedConfirmed(emails);
    const send = await dueSend();
    const { guard, env: capped } = guarded();
    const limit = getConfig(capped).subrequestBudget;
    expect(limit).toBe(50);

    const statementsBefore = guard.statements;
    await sweep(capped);
    const spent = guard.statements - statementsBefore + ses.requests;

    expect(spent).toBeLessThanOrEqual(limit);
    expect(ses.requests).toBeGreaterThanOrEqual(15);
    expect((await sends.deliveryRollup(env.DB, send.id)).accepted).toBe(ses.requests);
  });

  it("a run cut off after a group's requests leaves at most a group for Resolve, and re-mails no one", async () => {
    const emails = addresses(25);
    await seedConfirmed(emails);
    const send = await dueSend();

    // The group is handed off and sent, then the run dies before recording the answers.
    const original = sends.settleDeliveries;
    const settle = vi.spyOn(sends, "settleDeliveries").mockImplementation(async (...args) => {
      if (args[3] === "dispatched") {
        throw new Error("invocation cut off");
      }
      return original(...args);
    });
    await expect(runSend(env, send.id)).rejects.toThrow("invocation cut off");
    settle.mockRestore();
    const mailedFirst = ses.mailed.length;
    expect(mailedFirst).toBe(10);

    // The lease runs out, and later ticks finish the send around the unknown group.
    await env.DB.prepare("UPDATE sends SET locked_until = ? WHERE id = ?")
      .bind(Date.now() - 1, send.id)
      .run();
    for (let i = 0; i < 4; i += 1) {
      await tick();
    }

    const rollup = await sends.deliveryRollup(env.DB, send.id);
    expect(rollup).toEqual({ accepted: 15, dispatched: 10 });
    expect(emails.every((e) => ses.timesMailed(e) === 1)).toBe(true);
    expect(ses.mailed.length).toBe(25);
  });

  it("a paused account costs one request a retry, not one per recipient in the group", async () => {
    await seedConfirmed(addresses(30));
    const send = await dueSend();
    ses.refuse = "SendingPausedException";

    await runSend(env, send.id);

    expect(ses.requests).toBe(1);
    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.halt_reason).toBe("account");
    expect(row.c_in_flight).toBe(0);
    expect(row.c_pending).toBe(30);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ pending: 30 });
  });

  it("starts requests no faster than the provider's rate", async () => {
    vi.useRealTimers();
    const paced = new (class extends SesLikeProvider {
      readonly maxRequestRate = 50;
      readonly starts: number[] = [];
      override async sendBatch(...args: Parameters<SesLikeProvider["sendBatch"]>) {
        this.starts.push(performance.now());
        return super.sendBatch(...args);
      }
    })();
    vi.mocked(providers.getProvider).mockReturnValue(paced);
    await seedConfirmed(addresses(10));
    const send = await dueSend();

    await runSend(env, send.id);

    expect(paced.starts).toHaveLength(10);
    const first = paced.starts[0]!;
    const last = paced.starts[paced.starts.length - 1]!;
    // Ten starts at 50 a second span at least nine 20 ms gaps.
    expect(last - first).toBeGreaterThanOrEqual(9 * 20 - 5);
  });
});

/** SES-shaped, answering each request by a script: `ok` accepts, `rate` is a throttle,
 *  `refuse` an account refusal, and `lost` mails the recipient but loses the answer. */
class ScriptedSesProvider extends SesLikeProvider {
  script: ("ok" | "rate" | "lost" | "refuse")[] = [];
  private calls = 0;
  override async sendBatch(...args: Parameters<SesLikeProvider["sendBatch"]>) {
    const step = this.script[this.calls] ?? "ok";
    this.calls += 1;
    if (step === "rate") {
      this.rateLimit = 1;
    } else if (step === "refuse") {
      this.refuse = "SendingPausedException";
    } else if (step === "lost") {
      this.loseAnswers = 1;
    }
    try {
      return await super.sendBatch(...args);
    } finally {
      this.refuse = null;
    }
  }
}

describe("a group whose requests are answered differently", () => {
  let ses: ScriptedSesProvider;

  beforeEach(() => {
    ses = new ScriptedSesProvider();
    vi.mocked(providers.getProvider).mockReturnValue(ses);
  });

  it("records each answer, keeps the lost one for Resolve, and halts for the account", async () => {
    const emails = addresses(5);
    await seedConfirmed(emails);
    const send = await dueSend();
    ses.script = ["ok", "ok", "rate", "lost", "refuse"];

    await runSend(env, send.id);

    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({
      accepted: 2,
      dispatched: 1,
      pending: 2,
    });
    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.halt_reason).toBe("account");
    expect([row.c_accepted, row.c_in_flight, row.c_pending]).toEqual([2, 1, 2]);
    // The throttled and refused batches provably reached no one, so they keep no key.
    const keyed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND status = 'pending' AND dispatch_key IS NOT NULL",
    )
      .bind(send.id)
      .first<{ n: number }>();
    expect(keyed!.n).toBe(0);
    // Mailed are exactly the accepted two and the one whose answer was lost.
    const reached = await env.DB.prepare(
      "SELECT email FROM deliveries WHERE send_id = ? AND status IN ('accepted', 'dispatched') ORDER BY email",
    )
      .bind(send.id)
      .all<{ email: string }>();
    expect(ses.mailed.map((m) => m.to).sort()).toEqual(reached.results.map((r) => r.email));
  });

  it("re-checks consent for a group that never went out after its first request halted", async () => {
    const emails = addresses(10);
    await seedConfirmed(emails);
    const send = await dueSend();
    ses.script = ["refuse"];

    await runSend(env, send.id);
    expect(ses.requests).toBe(1);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ pending: 10 });

    // One of the group unsubscribes while the send waits out the refusal.
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
      .bind(emails[5])
      .run();
    await tick();

    expect(ses.timesMailed(emails[5]!)).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 9, skipped: 1 });
  });

  it("returns never-sent batches to the queue without touching the send's halt", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    const now = Date.now();
    const lease = (await sends.acquireLease(env.DB, send.id, now, LEASE_TTL_MS))!;
    await sends.resolveAudience(env.DB, send.id, now);
    await env.DB.prepare(
      "UPDATE sends SET halt_reason = 'unavailable', halt_cause = 'outage', halt_retries = 2 WHERE id = ?",
    )
      .bind(send.id)
      .run();
    const ids = await sends.pendingDeliveryIds(env.DB, send.id, 10);
    await sends.dispatchFresh(env.DB, send.id, lease, [{ key: "k1", ids }], now);

    await sends.holdBatch(
      env.DB,
      send.id,
      lease,
      [{ key: "k1", keepKey: false }],
      null,
      HALT_BACKOFF_MS.unavailable,
      now,
    );

    const row = (await sends.getSend(env.DB, send.id))!;
    expect([row.halt_reason, row.halt_cause, row.halt_retries]).toEqual([
      "unavailable",
      "outage",
      2,
    ]);
    expect([row.c_pending, row.c_in_flight]).toEqual([3, 0]);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ pending: 3 });
  });
});

describe("the tick's clock", () => {
  let ses: SesLikeProvider;

  beforeEach(() => {
    ses = new SesLikeProvider();
    vi.mocked(providers.getProvider).mockReturnValue(ses);
  });

  it("starts nothing once the tick's window has closed, and leaves the send to the next tick", async () => {
    await seedConfirmed(addresses(5));
    const send = await dueSend();

    await runSend(env, send.id, new Budget(1000), new SendWindow(undefined, 0));

    expect(ses.requests).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ pending: 5 });
    expect((await sends.getSend(env.DB, send.id))!.locked_until).toBeNull();
  });

  it("keeps one pace and one deadline across every send in the tick", async () => {
    vi.useRealTimers();
    await seedConfirmed(addresses(10));
    const a = await dueSend();
    const b = await dueSend();
    // 100 a second in a 60 ms window: at most seven starts, whichever send makes them.
    const window = new SendWindow(100, 60);
    const budget = new Budget(1000);

    await runSend(env, a.id, budget, window);
    const afterA = ses.requests;
    await runSend(env, b.id, budget, window);

    expect(afterA).toBeGreaterThan(0);
    expect(afterA).toBeLessThanOrEqual(7);
    expect(ses.requests).toBe(afterA);
  });
});

describe("the hand-off and close writes", () => {
  it("find their rows by primary key, never by walking the send's pending rows", async () => {
    const emails = addresses(12);
    await seedConfirmed(emails);
    const send = await dueSend();
    // One reader leaves before the send, so the close write runs too.
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
      .bind(emails[0])
      .run();
    const seen: { sql: string; binds: unknown[] }[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    const spying = {
      ...env.DB,
      batch: env.DB.batch.bind(env.DB),
      prepare: (sql: string) => {
        const stmt = prepare(sql);
        const bind = stmt.bind.bind(stmt);
        stmt.bind = (...binds: unknown[]) => {
          seen.push({ sql, binds });
          return bind(...binds);
        };
        return stmt;
      },
    } as unknown as D1Database;
    vi.mocked(providers.getProvider).mockReturnValue(new SesLikeProvider());

    await runSend({ ...env, DB: spying } as AppEnv, send.id, new Budget(1000));

    const writes = seen.filter(
      (s) =>
        /UPDATE deliveries SET status = 'dispatched',\s+dispatch_key =/.test(s.sql) ||
        /UPDATE deliveries SET\s+status = json_extract/.test(s.sql),
    );
    expect(writes.length).toBeGreaterThanOrEqual(3); // hand-offs, the close, the records
    for (const w of writes) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${w.sql}`)
        .bind(...w.binds)
        .all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join("\n");
      expect(details).toMatch(
        /SEARCH deliveries USING (INDEX sqlite_autoindex_deliveries_1|PRIMARY KEY) \(id=\?\)/,
      );
      expect(details).not.toMatch(/idx_deliveries_send_status/);
    }
  });
});

describe("SES_MAX_SEND_RATE", () => {
  const rateFor = (v: string | undefined) =>
    getConfig({ ...env, SES_MAX_SEND_RATE: v } as AppEnv).sesMaxSendRate;

  it("defaults to a new production account's rate, takes the account's own, and refuses a typo", () => {
    expect(rateFor(undefined)).toBe(DEFAULT_SES_MAX_SEND_RATE);
    expect(rateFor("1")).toBe(1);
    expect(rateFor("200")).toBe(200);
    expect(() => rateFor("fast")).toThrow(ConfigError);
    expect(() => rateFor("0")).toThrow(/SES_MAX_SEND_RATE/);
  });
});
