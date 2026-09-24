import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import {
  ConfigError,
  DEFAULT_SUBREQUEST_BUDGET,
  getConfig,
  MIN_SUBREQUEST_BUDGET,
} from "../src/env";
import { HALT_BACKOFF_MS, LEASE_TTL_MS } from "../src/lib/time";
import { NOTIFY_RESERVE } from "../src/notify/notify";
import * as providers from "../src/providers";
import { Budget } from "../src/send/budget";
import { MIN_RUN_COST, runSend } from "../src/send/loop";
import { resolveStuckSend } from "../src/send/resolve";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";
import { guardD1 } from "./support/d1_guard";
import { ResendLikeProvider } from "./support/resend_like";

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
    expect(await sends.dispatchFresh(env.DB, send.id, stale, "k-stale", ids, now)).toEqual([]);
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
    expect(await sends.dispatchFresh(env.DB, send.id, successor, "k1", ids, now)).toHaveLength(2);

    expect(await sends.redispatch(env.DB, send.id, stale, "k1", now)).toEqual([]);
    await sends.holdBatch(
      env.DB,
      send.id,
      stale,
      "k1",
      true,
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
