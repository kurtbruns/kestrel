import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { HALT_BACKOFF_MS, MAX_DELIVERY_ATTEMPTS, STUCK_THRESHOLD_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import { SesProvider } from "../src/providers/ses";
import type { SendBatchResult } from "../src/providers/types";
import { Budget } from "../src/send/budget";
import { runSend } from "../src/send/loop";
import { sweep } from "../src/send/sweep";
import { BatchProvider, SesLikeProvider } from "./support/batching";
import { nextRetry } from "./support/clock";
import { has } from "./support/conditions";
import { guardD1 } from "./support/d1_guard";
import { addresses, dueSend, resetDatabase, seedConfirmed, tick, ticks } from "./support/fixtures";
import { allowErrorLogs } from "./support/log";
import { answerSes, entryOk } from "./support/ses";
import { viewOf } from "./support/view";

// A failure that is the provider's or the account's halts the send's run, not its
// recipients (SPEC §6 step 5, §12): nobody is recorded unsent or spends an attempt, the
// send stays open, and once the fault clears everyone is mailed exactly once (I4).

/** More sweep ticks than the per-recipient cap, so a halt that spent attempts would show. */
const TICKS = MAX_DELIVERY_ATTEMPTS + 2;

/** The test env with its D1 held to the 100-bind cap. */
function capped(): AppEnv {
  return { ...env, DB: guardD1(env.DB).db } as AppEnv;
}

/** One sweep tick at the cron's own pace: the clock a minute on, never further. */
async function minute(e: AppEnv = capped()): Promise<void> {
  vi.setSystemTime(Date.now() + 60_000);
  await sweep(e);
}

async function untilSent(sendId: string, max = 30): Promise<void> {
  const e = capped();
  for (let i = 0; i < max && (await sends.getSend(env.DB, sendId))!.status !== "sent"; i++) {
    await tick(e);
  }
}

/** Every delivery row of a send, as the halt tests read them. */
async function rows(sendId: string) {
  const { results } = await env.DB.prepare(
    "SELECT email, status, attempts FROM deliveries WHERE send_id = ? ORDER BY email",
  )
    .bind(sendId)
    .all<{ email: string; status: string; attempts: number }>();
  return results;
}

/** Nobody consumed: every recipient still pending with no attempt spent, the send open. */
async function expectHeld(sendId: string, audience: number) {
  const all = await rows(sendId);
  expect(all).toHaveLength(audience);
  expect(all.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
  const send = (await sends.getSend(env.DB, sendId))!;
  expect(send.status).toBe("sending");
  expect(send.c_unsent).toBe(0);
  return send;
}

let transport: BatchProvider;

beforeEach(async () => {
  await resetDatabase();
  // Only Date is faked: the backoff is read off the clock, and D1 and the provider stubs
  // still resolve on their own.
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a provider outage", () => {
  it("a whole-batch 429 or 5xx keeps everyone pending, attempts unspent, across many ticks", async () => {
    allowErrorLogs("send.stuck");
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    transport.rateLimit = TICKS;
    await ticks(TICKS, capped());

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("unavailable");
    expect(held.halt_error).toContain("429");
    expect(transport.requests).toBe(TICKS); // one batch a tick, not every batch every tick

    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBeNull();
  });

  it("a provider that is down keeps everyone pending, attempts unspent, across many ticks", async () => {
    allowErrorLogs("send.stuck");
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    transport.outage = TICKS;
    await ticks(TICKS, capped());

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("unavailable");
    expect(held.halt_error).toContain("503");

    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
  });

  it("never re-sends a batch accepted before the outage, and sends the rest once it ends (I4)", async () => {
    allowErrorLogs("send.stuck", "send.ambiguous", "send.wedged");
    const emails = addresses(150);
    await seedConfirmed(emails);
    const send = await dueSend();

    transport.loseAnswers = 1; // the first batch is accepted, its answer lost
    await tick(capped());
    transport.outage = 2;
    transport.rateLimit = TICKS;
    await ticks(TICKS + 2, capped());
    for (let i = 0; i < 30 && (await sends.getSend(env.DB, send.id))!.c_pending > 0; i++) {
      await tick(capped());
    }

    // The batch of unknown fate waits for Resolve; everyone else went out once.
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 100, accepted: 50 });
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
  });

  it("reads backing-off and stays quiet until the stuck threshold", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.rateLimit = 2;
    await ticks(2, capped());

    const prog = viewOf((await sends.getSend(env.DB, send.id))!, "ses", false, Date.now());
    expect(prog.phase).toBe("backing-off");
    expect(prog.provider.halt).toMatchObject({ reason: "unavailable" });
    expect([has(prog, "refused"), has(prog, "stuck"), has(prog, "wedged")]).toEqual([
      false,
      false,
      false,
    ]);

    // Still quiet at the threshold itself, and raised as stuck just past it, backing off all
    // the while.
    const row = (await sends.getSend(env.DB, send.id))!;
    const threshold = row.started_at! + STUCK_THRESHOLD_MS;
    const at = (now: number) => viewOf(row, "ses", false, now);
    expect([at(threshold).phase, has(at(threshold), "stuck")]).toEqual(["backing-off", false]);
    expect([at(threshold + 1).phase, has(at(threshold + 1), "stuck")]).toEqual([
      "backing-off",
      true,
    ]);
  });
});

describe("a request with no answer on a provider without a key", () => {
  it("waits out an outage's backoff rather than strand a fresh batch every tick (SPEC §12)", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    const ses = new SesLikeProvider();
    vi.mocked(providers.getProvider).mockReturnValue(ses);
    ses.loseAnswers = 1;

    await sweep(capped());

    const row = (await sends.getSend(env.DB, send.id))!;
    expect([row.halt_reason, row.halt_cause]).toEqual(["unavailable", "outage"]);
    expect(row.halt_retry_at).toBeGreaterThan(Date.now());
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 1, pending: 2 });
    await sweep(capped()); // the same minute: the retry isn't due
    expect(ses.requests).toBe(1);
    await untilSent(send.id, 5); // later ticks send the rest; the lost one waits for Resolve
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 1, accepted: 2 });
  });
});

describe("the provider refusing the account", () => {
  it("halts without consuming recipients, reports one condition, and resumes once fixed", async () => {
    allowErrorLogs("send.stuck");
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await ticks(TICKS, capped());

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("account");
    expect(transport.requests).toBe(TICKS); // one refused request a tick, then the run stops
    const prog = viewOf(held, "ses", false, Date.now());
    expect(prog.phase).toBe("needs-attention");
    expect(has(prog, "refused")).toBe(true);
    expect(prog.provider.halt?.error).toBe(
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid",
    );
    const refusedSince = prog.provider.halt?.since;
    expect(refusedSince).toBe(held.halted_at);

    transport.refuse = null; // the operator rotated the key
    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBeNull();
  });

  it("clears the refusal on the first answered batch, while the send is still going", async () => {
    await seedConfirmed(addresses(1000)); // more than one free-plan tick delivers
    const send = await dueSend();
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await tick(capped());
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBe("account");

    transport.refuse = null;
    await tick(capped());
    const going = (await sends.getSend(env.DB, send.id))!;
    expect(going.status).toBe("sending");
    expect(going.c_accepted).toBeGreaterThan(0);
    expect(going).toMatchObject({ halt_reason: null, halt_error: null, halted_at: null });
    expect(has(viewOf(going, "ses", false, Date.now()), "refused")).toBe(false);
  });

  it("keeps when the refusal began across ticks, and restarts it when the reason changes", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.refuse = "transport batch 403: API key is not active";
    await tick(capped());
    const first = (await sends.getSend(env.DB, send.id))!.halted_at!;
    await env.DB.prepare("UPDATE sends SET halted_at = halted_at - 60000 WHERE id = ?")
      .bind(send.id)
      .run();
    await tick(capped());
    expect((await sends.getSend(env.DB, send.id))!.halted_at).toBe(first - 60_000);

    transport.refuse = null;
    transport.rateLimit = 1;
    await tick(capped());
    const now = (await sends.getSend(env.DB, send.id))!;
    expect(now.halt_reason).toBe("unavailable");
    expect(now.halted_at).toBeGreaterThanOrEqual(first);
  });
});

describe("the halt's backoff", () => {
  const MIN = 60_000;

  /** Record the clock at every provider request, as minutes since the first. Each request
   *  takes a second to answer, as a real one does, so the halt is stamped a moment after the
   *  tick began and not exactly on it. */
  function requestMinutes(provider: BatchProvider): () => number[] {
    const at: number[] = [];
    const send = provider.sendBatch.bind(provider);
    vi.spyOn(provider, "sendBatch").mockImplementation((...args) => {
      at.push(Date.now());
      vi.setSystemTime(Date.now() + 1000);
      return send(...args);
    });
    return () => at.map((t) => Math.round((t - at[0]!) / MIN));
  }

  /** The cron minutes a backoff spec sweeps on, given the minutes its retries should land
   *  on: each retry's own, the one after it, the one before the next retry, and the last.
   *  A halted send's retry, once due, stays due, so a step that ran short would fire on the
   *  tick just before the retry it names; sweeping every minute in between proves nothing
   *  more and costs a slow CI runner seconds. */
  function visits(retries: readonly number[], last: number): number[] {
    const at = new Set([last]);
    retries.forEach((r, j) => {
      at.add(r);
      at.add(r + 1);
      at.add((retries[j + 1] ?? last + 1) - 1);
    });
    return [...at].filter((m) => m <= last).sort((a, b) => a - b);
  }

  it.each([
    ["unavailable", [0, 1, 3, 8, 23, 53, 113, 173]],
    ["account", [0, 5, 20, 50, 110, 170]],
  ] as const)("spaces %s retries out across ticks, consuming no one", async (reason, expected) => {
    allowErrorLogs("send.stuck");
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();
    const minutes = requestMinutes(transport);
    if (reason === "account") {
      transport.refuse =
        "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    } else {
      transport.rateLimit = 1_000;
    }

    // Ticks on the cron's own minutes, however long each request took. The first request is
    // on the first tick, a minute in, so each retry is due a minute past its expected one.
    const start = Date.now();
    const due = expected.map((m) => m + 1);
    let retries = 0;
    for (const i of visits(due, 180)) {
      vi.setSystemTime(start + i * MIN);
      const before = transport.requests;
      await sweep(capped());
      expect(transport.requests - before, `minute ${i}`).toBe(due.includes(i) ? 1 : 0);
      const now = (await sends.getSend(env.DB, send.id))!;
      if (now.halt_retries > retries) {
        // Each halt schedules the next retry by the schedule's next step, capped at its last.
        retries = now.halt_retries;
        const steps = HALT_BACKOFF_MS[reason];
        expect(now.halt_retry_at! - Date.now()).toBe(steps[Math.min(retries, steps.length) - 1]);
      }
    }

    expect(minutes()).toEqual(expected);
    const held = await expectHeld(send.id, 250);
    expect(held.halt_retries).toBe(expected.length);
    const prog = viewOf(held, "ses", false, Date.now());
    expect(prog.provider.halt?.retry_at).toBe(held.halt_retry_at);
    expect(prog.provider.halt!.retry_at).toBeGreaterThan(Date.now());
    expect(prog.phase).toBe(reason === "account" ? "needs-attention" : "backing-off");
    expect(has(prog, "stuck")).toBe(true); // a long halt is still raised
  });

  it("returns to every-tick pace the moment a batch is answered", async () => {
    await seedConfirmed(addresses(2000)); // several free-plan ticks' worth
    const send = await dueSend();
    transport.rateLimit = 4;
    await ticks(4, capped()); // four halts: the next retry would be fifteen minutes out
    expect((await sends.getSend(env.DB, send.id))!.halt_retries).toBe(4);

    await tick(capped()); // answered
    const going = (await sends.getSend(env.DB, send.id))!;
    expect(going.status).toBe("sending");
    expect(going.c_accepted).toBeGreaterThan(0);
    expect(going).toMatchObject({ halt_reason: null, halt_retries: 0, halt_retry_at: null });

    const before = transport.requests;
    await minute(); // the very next tick carries on
    expect(transport.requests).toBeGreaterThan(before);

    transport.rateLimit = 1; // a fresh halt starts the schedule from the top
    await minute();
    const again = (await sends.getSend(env.DB, send.id))!;
    expect(again.halt_retries).toBe(1);
    expect(again.halt_retry_at! - Date.now()).toBe(HALT_BACKOFF_MS.unavailable[0]);
  });

  it("costs a waiting send no provider request and nothing past the sweep's query", async () => {
    allowErrorLogs("send.stuck");
    const limit = getConfig(env).subrequestBudget;
    // An idle tick's cost, with nothing to send.
    const idle = guardD1(env.DB);
    await sweep({ ...env, DB: idle.db } as AppEnv);

    await seedConfirmed(addresses(3));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await dueSend()).id);
    }
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";

    // Two hours of cron minutes. After a tick that waited, the clock jumps to the minute
    // before the next retry falls due: a waiting tick costs the same on any minute, and a
    // retry run early would still land on one of the ticks this visits.
    const start = Date.now();
    let waitingTicks = 0;
    for (let i = 1; i <= 120; i++) {
      const guard = guardD1(env.DB);
      const requests = transport.requests;
      vi.setSystemTime(start + i * MIN);
      const due = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sends WHERE status IN ('scheduled', 'sending')
            AND (halt_retry_at IS NULL OR halt_retry_at <= ?)`,
      )
        .bind(Date.now())
        .first<number>("n");
      await sweep({ ...env, DB: guard.db } as AppEnv);
      expect(guard.statements + transport.requests - requests).toBeLessThanOrEqual(limit);
      if (due === 0) {
        // Five sends waiting out their backoff cost what a tick with nothing to send does.
        waitingTicks += 1;
        expect(transport.requests).toBe(requests);
        expect(guard.statements).toBe(idle.statements);
        const next = await nextRetry(env.DB);
        if (next !== null) {
          i = Math.max(i, Math.ceil((next - start) / MIN) - 2);
        }
      }
    }
    expect(waitingTicks).toBeGreaterThan(5);
    // Every send retried on the account schedule, never once a tick.
    expect(transport.requests).toBe(5 * 5);
    for (const id of ids) {
      await expectHeld(id, 3);
    }
  });

  it("mails everyone exactly once after the fault clears, at the next scheduled retry", async () => {
    allowErrorLogs("send.stuck");
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();
    transport.rateLimit = 1_000;
    for (let i = 0; i < 40; i++) {
      await minute();
    }
    await expectHeld(send.id, 250);

    transport.rateLimit = 0; // the outage ends between retries
    const due = (await sends.getSend(env.DB, send.id))!.halt_retry_at!;
    const before = transport.requests;
    while (Date.now() + MIN < due) {
      await minute();
      expect(transport.requests).toBe(before); // still waiting out the step it was on
    }
    for (let i = 0; i < 10 && (await sends.getSend(env.DB, send.id))!.status !== "sent"; i++) {
      await minute();
    }

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
    expect(await rows(send.id)).toSatisfy((all: { attempts: number }[]) =>
      all.every((r) => r.attempts === 0),
    );
  });
});

describe("a refused batch", () => {
  const keysOf = async (sendId: string) =>
    (
      await env.DB.prepare(
        "SELECT DISTINCT dispatch_key AS k FROM deliveries WHERE send_id = ? AND dispatch_key IS NOT NULL",
      )
        .bind(sendId)
        .all<{ k: string }>()
    ).results;

  it("drops the key of a refused batch, so it is made again from scratch", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await tick(capped());
    expect(await keysOf(send.id)).toEqual([]);
    transport.rateLimit = 1; // a definite 429 on a first attempt, likewise
    transport.refuse = null;
    await tick(capped());
    expect(await keysOf(send.id)).toEqual([]);
  });

  it("honors an unsubscribe that lands while the account is refused (I2)", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await ticks(2, capped());
    const leaving = emails[1]!;
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
      .bind(leaving)
      .run();

    transport.refuse = null;
    await untilSent(send.id);

    expect(transport.timesMailed(leaving)).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 2, skipped: 1 });
  });

  it("never re-sends a batch of unknown fate, through a refusal and its fix (I4)", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    transport.loseAnswers = 1; // accepted, the answer lost
    await tick(capped());
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await ticks(2, capped());
    transport.refuse = null; // the operator fixed the key
    const before = transport.requests;
    await ticks(3, capped());

    expect(transport.requests).toBe(before); // nothing re-sends a batch of unknown fate
    expect(emails.every((e) => transport.timesMailed(e) === 1)).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 3 });
    const prog = viewOf((await sends.getSend(env.DB, send.id))!, "ses", false, Date.now());
    expect(has(prog, "wedged")).toBe(true);
  });

  it("delivers to everyone after a refused account is replaced, nothing left for Resolve", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await ticks(2, capped());

    // The operator moves the deployment to another account.
    const ses = new SesLikeProvider();
    vi.mocked(providers.getProvider).mockReturnValue(ses);
    await untilSent(send.id);

    expect(emails.every((e) => ses.timesMailed(e) === 1)).toBe(true);
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.halt_reason).toBeNull();
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
  });
});

describe("the real adapters, end to end through the loop", () => {
  // An account allowed 1,000 a second takes a full 50 a request, so each spec's batch is
  // one request and none waits out SES's one request a second.
  const sesEnv = {
    ...env,
    AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
    AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
    SES_MAX_SEND_RATE: "1000",
  } as AppEnv;
  const sesAdapter = () => new SesProvider(getConfig(sesEnv), sesEnv);

  it("an SES SendingPausedException halts the send without consuming anyone, then resumes", async () => {
    const emails = addresses(20);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(sesAdapter());

    let paused = true;
    const { spy, mailed } = answerSes(undefined, () =>
      paused
        ? new Response(
            JSON.stringify({ __type: "SendingPausedException", message: "Account is paused" }),
            { status: 400 },
          )
        : null,
    );
    const result = await runSend(capped(), send.id, new Budget(1000));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.halt).toBe("account");
    const held = await expectHeld(send.id, 20);
    expect(held.halt_error).toBe("ses 400 SendingPausedException: Account is paused");
    expect(held.c_in_flight).toBe(0); // an answered refusal is never an ambiguous delivery

    paused = false; // the operator resumed sending in the SES console
    const done = await runSend(capped(), send.id, new Budget(1000));
    expect(done.finished).toBe(true);
    expect(emails.every((e) => mailed.get(e) === 1)).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 20 });
  });

  it("SES holding back part of a batch for a spent quota spends no attempt, and the send says why (SPEC §12)", async () => {
    const emails = addresses(20);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(sesAdapter());
    const taken = new Set(emails.slice(0, 2));
    const { spy } = answerSes((to) =>
      taken.has(to)
        ? entryOk()
        : { Status: "ACCOUNT_DAILY_QUOTA_EXCEEDED", Error: "Daily message quota exceeded." },
    );

    const result = await runSend(capped(), send.id, new Budget(1000));

    expect(spy).toHaveBeenCalledTimes(1); // the run stops at the refusal
    expect(result.halt).toBe("account");
    const row = (await sends.getSend(env.DB, send.id))!;
    expect([row.halt_reason, row.halt_cause]).toEqual(["account", "quota"]);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 2, pending: 18 });
    const held = (await rows(send.id)).filter((r) => r.status === "pending");
    expect(held.every((r) => r.attempts === 0)).toBe(true);
  });

  it("a group whose first request SES partly held back sends nothing more that tick", async () => {
    // An account allowed three a second: batches of three, three batches a group.
    const slow = { ...sesEnv, SES_MAX_SEND_RATE: "3" } as AppEnv;
    const emails = addresses(9);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(new SesProvider(getConfig(slow), slow));
    let first = true;
    const { spy } = answerSes(() => {
      const answer = first
        ? entryOk()
        : { Status: "ACCOUNT_DAILY_QUOTA_EXCEEDED", Error: "Daily message quota exceeded." };
      first = false;
      return answer;
    });

    await runSend(capped(), send.id, new Budget(1000));

    expect(spy).toHaveBeenCalledTimes(1); // the probe alone; the rest of the group waits
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 1, pending: 8 });
    expect((await rows(send.id)).every((r) => r.attempts === 0)).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.halt_cause).toBe("quota");
  });

  it("an SES entry rejected for its own address is that recipient's alone: recorded unsent, the rest delivered", async () => {
    const emails = addresses(4);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(sesAdapter());
    answerSes((to) =>
      to === emails[1] ? { Status: "MESSAGE_REJECTED", Error: "bad" } : entryOk(),
    );

    const result = await runSend(capped(), send.id, new Budget(1000));
    expect(result.finished).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3, unsent: 1 });
  });
});

describe("a recipient's own retryable failure", () => {
  it("still counts toward the attempt cap and ends unsent", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    // A 2xx that names no message for this recipient: its own ambiguity, not an outage.
    const flaky = new (class extends BatchProvider {
      override async sendBatch(): Promise<SendBatchResult> {
        this.requests += 1;
        return {
          kind: "answered",
          results: [
            { email: addresses(2)[0]!, accepted: true, providerId: "re_ok" },
            {
              email: addresses(2)[1]!,
              accepted: false,
              retryable: true,
              error: "transport batch: missing id in response",
            },
          ],
        };
      }
    })();
    vi.mocked(providers.getProvider).mockReturnValue(flaky);

    await untilSent(send.id, MAX_DELIVERY_ATTEMPTS + 3);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    const byEmail = Object.fromEntries((await rows(send.id)).map((r) => [r.email, r]));
    expect(byEmail[addresses(2)[0]!]!.status).toBe("accepted");
    expect(byEmail[addresses(2)[1]!]).toMatchObject({
      status: "unsent",
      attempts: MAX_DELIVERY_ATTEMPTS,
    });
  });
});
