import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { HALT_BACKOFF_MS, MAX_DELIVERY_ATTEMPTS } from "../src/lib/time";
import * as providers from "../src/providers";
import { ResendProvider } from "../src/providers/resend";
import { SesProvider } from "../src/providers/ses";
import type { SendBatchResult } from "../src/providers/types";
import { Budget } from "../src/send/budget";
import { runSend } from "../src/send/loop";
import { buildSendProgress } from "../src/send/progress";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";
import { guardD1 } from "./support/d1_guard";
import { ResendLikeProvider } from "./support/resend_like";

// A failure that is the provider's or the account's halts the send's run, not its
// recipients (SPEC §6 step 5, §12): nobody is recorded unsent or spends an attempt, the
// send stays open, and once the fault clears everyone is mailed exactly once (I4).

/** More sweep ticks than the per-recipient cap, so a halt that spent attempts would show. */
const TICKS = MAX_DELIVERY_ATTEMPTS + 2;

const addresses = (n: number, tag = "h") =>
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

/** The test env with its D1 held to the 100-bind cap. */
function capped(): AppEnv {
  return { ...env, DB: guardD1(env.DB).db } as AppEnv;
}

/** One sweep tick, on the next minute or the next halt retry, whichever is later: so each
 *  tick here is one retry of a halted send. */
async function tick(e: AppEnv = capped()): Promise<void> {
  await toNextTick(env.DB);
  await sweep(e);
}

/** One sweep tick at the cron's own pace: the clock a minute on, never further. */
async function minute(e: AppEnv = capped()): Promise<void> {
  vi.setSystemTime(Date.now() + 60_000);
  await sweep(e);
}

async function ticks(n: number, e: AppEnv = capped()): Promise<void> {
  for (let i = 0; i < n; i++) {
    await tick(e);
  }
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
  // Only Date is faked: the backoff is read off the clock, and D1 and the provider stubs
  // still resolve on their own.
  vi.useFakeTimers({ toFake: ["Date"] });
  resend = new ResendLikeProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(resend);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a provider outage", () => {
  it("a whole-batch 429 or 5xx keeps everyone pending, attempts unspent, across many ticks", async () => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    resend.rateLimit = TICKS;
    await ticks(TICKS);

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("unavailable");
    expect(held.halt_error).toContain("429");
    expect(resend.requests).toBe(TICKS); // one batch a tick, not every batch every tick

    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBeNull();
  });

  it("a request that throws keeps everyone pending, attempts unspent, across many ticks", async () => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    resend.outage = TICKS;
    await ticks(TICKS);

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("unavailable");
    expect(held.halt_error).toContain("connection refused");

    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
  });

  it("re-sends a batch accepted before the outage under its key, mailing no one twice", async () => {
    const emails = addresses(150);
    await seedConfirmed(emails);
    const send = await dueSend();

    resend.loseAnswers = 1; // the first batch is accepted, its answer lost
    await tick();
    resend.outage = 2;
    resend.rateLimit = TICKS;
    await ticks(TICKS + 2);

    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 150 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
  });

  it("reads backing-off and stays quiet until the stuck threshold", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    resend.rateLimit = 2;
    await ticks(2);

    const prog = buildSendProgress(
      (await sends.getSend(env.DB, send.id))!,
      "resend",
      false,
      Date.now(),
    );
    expect(prog.phase).toBe("backing-off");
    expect(prog.provider.halt).toMatchObject({ reason: "unavailable" });
    expect(prog.attention).toMatchObject({ refused: false, stuck: false, wedged: false });
  });
});

describe("the provider refusing the account", () => {
  it("halts without consuming recipients, reports one condition, and resumes once fixed", async () => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();

    resend.refuse = "resend batch 401: API key is invalid";
    await ticks(TICKS);

    const held = await expectHeld(send.id, 250);
    expect(held.halt_reason).toBe("account");
    expect(resend.requests).toBe(TICKS); // one refused request a tick, then the run stops
    const prog = buildSendProgress(held, "resend", false, Date.now());
    expect(prog.phase).toBe("needs-attention");
    expect(prog.attention.refused).toBe(true);
    expect(prog.provider.halt?.error).toBe("resend batch 401: API key is invalid");
    const refusedSince = prog.provider.halt?.since;
    expect(refusedSince).toBe(held.halted_at);

    resend.refuse = null; // the operator rotated the key
    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBeNull();
  });

  it("clears the refusal on the first answered batch, while the send is still going", async () => {
    await seedConfirmed(addresses(450)); // more than one free-plan tick delivers
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";
    await tick();
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBe("account");

    resend.refuse = null;
    await tick();
    const going = (await sends.getSend(env.DB, send.id))!;
    expect(going.status).toBe("sending");
    expect(going.c_accepted).toBeGreaterThan(0);
    expect(going).toMatchObject({ halt_reason: null, halt_error: null, halted_at: null });
    expect(buildSendProgress(going, "resend", false, Date.now()).attention.refused).toBe(false);
  });

  it("keeps when the refusal began across ticks, and restarts it when the reason changes", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    resend.refuse = "resend batch 403: API key is not active";
    await tick();
    const first = (await sends.getSend(env.DB, send.id))!.halted_at!;
    await env.DB.prepare("UPDATE sends SET halted_at = halted_at - 60000 WHERE id = ?")
      .bind(send.id)
      .run();
    await tick();
    expect((await sends.getSend(env.DB, send.id))!.halted_at).toBe(first - 60_000);

    resend.refuse = null;
    resend.rateLimit = 1;
    await tick();
    const now = (await sends.getSend(env.DB, send.id))!;
    expect(now.halt_reason).toBe("unavailable");
    expect(now.halted_at).toBeGreaterThanOrEqual(first);
  });
});

describe("the halt's backoff", () => {
  const MIN = 60_000;

  /** Record the clock at every provider request, as minutes since the first. */
  function requestMinutes(provider: ResendLikeProvider): () => number[] {
    const at: number[] = [];
    const send = provider.sendBatch.bind(provider);
    vi.spyOn(provider, "sendBatch").mockImplementation((...args) => {
      at.push(Date.now());
      return send(...args);
    });
    return () => at.map((t) => Math.round((t - at[0]!) / MIN));
  }

  it.each([
    ["unavailable", [0, 1, 3, 8, 23, 53, 113, 173]],
    ["account", [0, 5, 20, 50, 110, 170]],
  ] as const)("spaces %s retries out across ticks, consuming no one", async (reason, expected) => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();
    const minutes = requestMinutes(resend);
    if (reason === "account") {
      resend.refuse = "resend batch 401: API key is invalid";
    } else {
      resend.rateLimit = 1_000;
    }

    let retries = 0;
    for (let i = 0; i < 180; i++) {
      await minute();
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
    const prog = buildSendProgress(held, "resend", false, Date.now());
    expect(prog.provider.halt?.retry_at).toBe(held.halt_retry_at);
    expect(prog.provider.halt!.retry_at).toBeGreaterThan(Date.now());
    expect(prog.phase).toBe(reason === "account" ? "needs-attention" : "backing-off");
    expect(prog.attention.stuck).toBe(true); // a long halt is still raised
  });

  it("returns to every-tick pace the moment a batch is answered", async () => {
    await seedConfirmed(addresses(900)); // several free-plan ticks' worth
    const send = await dueSend();
    resend.rateLimit = 4;
    await ticks(4); // four halts: the next retry would be fifteen minutes out
    expect((await sends.getSend(env.DB, send.id))!.halt_retries).toBe(4);

    await tick(); // answered
    const going = (await sends.getSend(env.DB, send.id))!;
    expect(going.status).toBe("sending");
    expect(going.c_accepted).toBeGreaterThan(0);
    expect(going).toMatchObject({ halt_reason: null, halt_retries: 0, halt_retry_at: null });

    const before = resend.requests;
    await minute(); // the very next tick carries on
    expect(resend.requests).toBeGreaterThan(before);

    resend.rateLimit = 1; // a fresh halt starts the schedule from the top
    await minute();
    const again = (await sends.getSend(env.DB, send.id))!;
    expect(again.halt_retries).toBe(1);
    expect(again.halt_retry_at! - Date.now()).toBe(HALT_BACKOFF_MS.unavailable[0]);
  });

  it("costs a waiting send no provider request and nothing past the sweep's query", async () => {
    const limit = getConfig(env).subrequestBudget;
    // An idle tick's cost, with nothing to send.
    const idle = guardD1(env.DB);
    await sweep({ ...env, DB: idle.db } as AppEnv);

    await seedConfirmed(addresses(3));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await dueSend()).id);
    }
    resend.refuse = "resend batch 401: API key is invalid";

    let waitingTicks = 0;
    for (let i = 0; i < 120; i++) {
      const guard = guardD1(env.DB);
      const requests = resend.requests;
      vi.setSystemTime(Date.now() + MIN);
      const due = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sends WHERE status IN ('scheduled', 'sending')
            AND (halt_retry_at IS NULL OR halt_retry_at <= ?)`,
      )
        .bind(Date.now())
        .first<number>("n");
      await sweep({ ...env, DB: guard.db } as AppEnv);
      expect(guard.statements + resend.requests - requests).toBeLessThanOrEqual(limit);
      if (due === 0) {
        // Five sends waiting out their backoff cost what a tick with nothing to send does.
        waitingTicks += 1;
        expect(resend.requests).toBe(requests);
        expect(guard.statements).toBe(idle.statements);
      }
    }
    expect(waitingTicks).toBeGreaterThan(100);
    // Every send retried on the account schedule, never once a tick.
    expect(resend.requests).toBe(5 * 5);
    for (const id of ids) {
      await expectHeld(id, 3);
    }
  });

  it("mails everyone exactly once after the fault clears, at the next scheduled retry", async () => {
    const emails = addresses(250);
    await seedConfirmed(emails);
    const send = await dueSend();
    resend.rateLimit = 1_000;
    for (let i = 0; i < 40; i++) {
      await minute();
    }
    await expectHeld(send.id, 250);

    resend.rateLimit = 0; // the outage ends between retries
    const due = (await sends.getSend(env.DB, send.id))!.halt_retry_at!;
    const before = resend.requests;
    while (Date.now() + MIN < due) {
      await minute();
      expect(resend.requests).toBe(before); // still waiting out the step it was on
    }
    for (let i = 0; i < 10 && (await sends.getSend(env.DB, send.id))!.status !== "sent"; i++) {
      await minute();
    }

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 250 });
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect(await rows(send.id)).toSatisfy((all: { attempts: number }[]) =>
      all.every((r) => r.attempts === 0),
    );
  });
});

describe("a refused batch and its key", () => {
  const keysOf = async (sendId: string) =>
    (
      await env.DB.prepare(
        "SELECT DISTINCT dispatch_key AS k FROM deliveries WHERE send_id = ? AND dispatch_key IS NOT NULL",
      )
        .bind(sendId)
        .all<{ k: string }>()
    ).results;

  it("drops the key of a batch refused on its first attempt, so it is made again from scratch", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";
    await tick();
    expect(await keysOf(send.id)).toEqual([]);
    resend.rateLimit = 1; // a definite 429 on a first attempt, likewise
    resend.refuse = null;
    await tick();
    expect(await keysOf(send.id)).toEqual([]);
  });

  it("honors an unsubscribe that lands while the account is refused (I2)", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";
    await ticks(2);
    const leaving = emails[1]!;
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
      .bind(leaving)
      .run();

    resend.refuse = null;
    await untilSent(send.id);

    expect(resend.timesMailed(leaving)).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 2, skipped: 1 });
  });

  it("keeps the key of a batch whose fate was unknown when a refusal follows, mailing no one twice", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    resend.failAfterSending = 1; // a 5xx after the batch went out
    await tick();
    expect(await keysOf(send.id)).toHaveLength(1);
    resend.refuse = "resend batch 401: API key is invalid";
    await ticks(2);
    expect(await keysOf(send.id)).toHaveLength(1); // the refusal proves nothing about the first try

    resend.refuse = null;
    await untilSent(send.id);
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
  });

  it("sends a batch of unknown fate to Resolve once the provider has forgotten its key (I4)", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    resend.loseAnswers = 1; // accepted, the answer lost
    await tick();
    resend.refuse = "resend batch 401: API key is invalid";
    await ticks(2);
    // A day later the key is fixed, but Resend no longer remembers the batch's key.
    await env.DB.prepare(
      "UPDATE deliveries SET keyed_at = keyed_at - 24 * 60 * 60 * 1000 WHERE send_id = ?",
    )
      .bind(send.id)
      .run();
    resend.refuse = null;
    const before = resend.requests;
    await ticks(3);

    expect(resend.requests).toBe(before); // never re-sent under a key it can't dedupe
    expect(emails.every((e) => resend.timesMailed(e) === 1)).toBe(true);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 3 });
    const prog = buildSendProgress(
      (await sends.getSend(env.DB, send.id))!,
      "resend",
      false,
      Date.now(),
    );
    expect(prog.attention.wedged).toBe(true);
  });

  it("delivers to everyone after a switch to a provider without idempotency, nothing left for Resolve", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";
    await ticks(2);

    // The operator moves the deployment to an SES-shaped provider.
    const ses = new (class extends ResendLikeProvider {
      override readonly maxBatch: number = 1;
      override readonly idempotentRetry: boolean = false;
      override readonly idempotencyWindowMs: number | undefined = undefined;
    })();
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
  const resendEnv = { ...env, RESEND_API_KEY: "re_live_key" } as AppEnv;
  const resendAdapter = () => new ResendProvider(getConfig(env), resendEnv);

  function resendAnswers(status: number, body: unknown) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (status !== 200) {
        return new Response(JSON.stringify(body), { status });
      }
      const batch = JSON.parse(String(init?.body)) as unknown[];
      return new Response(JSON.stringify({ data: batch.map((_, i) => ({ id: `re_${i}` })) }));
    });
  }

  it.each([
    [401, { name: "missing_api_key", message: "Missing API key in the authorization header." }],
    [403, { name: "validation_error", message: "The send.example.com domain is not verified." }],
  ])("a Resend %i halts the send without consuming anyone, then resumes", async (status, body) => {
    await seedConfirmed(addresses(150));
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(resendAdapter());

    const refused = resendAnswers(status, body);
    await ticks(TICKS);
    expect(refused).toHaveBeenCalledTimes(TICKS);
    const held = await expectHeld(send.id, 150);
    expect(held.halt_reason).toBe("account");
    expect(held.halt_error).toContain(body.message);
    expect(held.halt_error).not.toContain("re_live_key");

    refused.mockRestore();
    const ok = resendAnswers(200, null);
    await untilSent(send.id);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 150 });
    expect(ok).toHaveBeenCalledTimes(2); // two batches of at most 100, each sent once
  });

  it("a Resend 422 is still a permanent failure of the batch's own recipients", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(resendAdapter());
    resendAnswers(422, { name: "missing_required_field", message: "The `to` field is missing." });

    await tick();

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ unsent: 3 });
  });

  const sesEnv = {
    ...env,
    AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
    AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
  } as AppEnv;

  /** SES answers per recipient; `answer` decides each request, and `mailed` counts accepts. */
  function sesAnswers(answer: (to: string) => Response) {
    const mailed = new Map<string, number>();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const req = input as Request;
      const to = (JSON.parse(await req.text()) as { Destination: { ToAddresses: string[] } })
        .Destination.ToAddresses[0]!;
      const res = answer(to);
      if (res.ok) {
        mailed.set(to, (mailed.get(to) ?? 0) + 1);
      }
      return res;
    });
    return { spy, mailed };
  }
  const sesOk = () => new Response(JSON.stringify({ MessageId: "m" }), { status: 200 });

  it("an SES SendingPausedException halts after one request instead of one per recipient", async () => {
    const emails = addresses(20);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(new SesProvider(getConfig(env), sesEnv));

    let paused = true;
    const { spy, mailed } = sesAnswers(() =>
      paused
        ? new Response(
            JSON.stringify({ __type: "SendingPausedException", message: "Account is paused" }),
            { status: 400 },
          )
        : sesOk(),
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

  it("an SES bad address is still that recipient's alone: recorded unsent, the rest delivered", async () => {
    const emails = addresses(4);
    await seedConfirmed(emails);
    const send = await dueSend();
    vi.mocked(providers.getProvider).mockReturnValue(new SesProvider(getConfig(env), sesEnv));
    sesAnswers((to) =>
      to === emails[1]
        ? new Response(JSON.stringify({ __type: "BadRequestException", message: "bad" }), {
            status: 400,
          })
        : sesOk(),
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
    const flaky = new (class extends ResendLikeProvider {
      override async sendBatch(): Promise<SendBatchResult> {
        this.requests += 1;
        return {
          kind: "answered",
          results: [
            { email: "h000@example.com", accepted: true, providerId: "re_ok" },
            {
              email: "h001@example.com",
              accepted: false,
              retryable: true,
              error: "resend batch: missing id in response",
            },
          ],
        };
      }
    })();
    vi.mocked(providers.getProvider).mockReturnValue(flaky);

    await untilSent(send.id, MAX_DELIVERY_ATTEMPTS + 3);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    const byEmail = Object.fromEntries((await rows(send.id)).map((r) => [r.email, r]));
    expect(byEmail["h000@example.com"]!.status).toBe("accepted");
    expect(byEmail["h001@example.com"]).toMatchObject({
      status: "unsent",
      attempts: MAX_DELIVERY_ATTEMPTS,
    });
  });
});
