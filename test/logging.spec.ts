import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import worker from "../src/index";
import { log, scrub, withRun } from "../src/lib/log";
import { STUCK_THRESHOLD_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import { clearFakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { cancel, freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { toNextTick } from "./support/clock";
import { type LoggedLine, logged } from "./support/log";
import { ResendLikeProvider } from "./support/resend_like";

// The structured log (SPEC §12): every line one JSON object, a send's lifecycle in order
// under its sendId, the lines of a tick or a request under one run, and never a
// recipient's address or token in any line.

const AUDIENCE = ["ada@example.com", "grace@example.com", "linus@example.org"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A provider with no idempotency key, as SES is: a request lost in flight is ambiguous. */
class NoKeyProvider extends ResendLikeProvider {
  override readonly idempotentRetry: boolean = false;
  override readonly idempotencyWindowMs: number | undefined = undefined;
}

let spies: MockInstance[] = [];

/** Every line the helper logged so far, in order. */
const lines = (): LoggedLine[] => logged(...spies);

const eventsFor = (sendId: string) =>
  lines()
    .filter((l) => l.sendId === sendId)
    .map((l) => l.event);

/** Nothing anyone printed names a reader, by address or by the token their links carry. */
function expectNoAddress(): void {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      const text = call.map(String).join(" ");
      for (const address of AUDIENCE) {
        expect(text).not.toContain(`${address.split("@")[0]}@`);
        expect(text).not.toContain(`uns-${address}`);
      }
    }
  }
}

async function seedConfirmed(emails: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at)
     SELECT 'id-' || value, value, 'confirmed', 'cfm-' || value, 'uns-' || value, ?, ? FROM json_each(?)`,
  )
    .bind(now, now, JSON.stringify(emails))
    .run();
}

async function scheduledSend(fireAt: number) {
  const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "hi" }, "test");
  return freeze(env, getConfig(env), post, fireAt);
}

/** The Worker's own fetch handler, waiting for the work it leaves to `waitUntil`. */
async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://kestrel.test${path}`, init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

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
  clearFakeOutbox();
  spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the send lifecycle in the log", () => {
  it("a send through the sweep logs fired, batch, completed in order under its sendId, and no address", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await withRun("tick-1", () => sweep(env));

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(eventsFor(send.id)).toEqual(["send.fired", "send.batch", "send.completed"]);
    const all = lines();
    // Every line of the tick carries its run, and the tick closes with its summary.
    expect(all.every((l) => l.run === "tick-1")).toBe(true);
    expect(all.at(-1)).toMatchObject({ event: "sweep.tick", level: "info", due: 1, ok: true });
    expect(all.find((l) => l.event === "send.fired")).toMatchObject({
      level: "info",
      postId: send.post_id,
      provider: "fake",
    });
    expect(all.find((l) => l.event === "send.batch")).toMatchObject({
      recipients: 3,
      accepted: 3,
      unsent: 0,
      retried: 0,
      held: 0,
      unknown: 0,
    });
    expectNoAddress();
  });

  it("a batch's counts add up to its recipients, a reader with no subscriber record included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new ResendLikeProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);
    // The first request's answer is lost, so the batch waits under its key to be re-sent
    // whole; by then one reader's subscriber record is gone, so the re-send closes them
    // unsent at hand-off rather than mail them with no unsubscribe link. Every member is
    // still counted once, whatever the provider answers for the rest.
    await sweep(env);
    const fetchGroup = sends.fetchDispatchGroup;
    vi.spyOn(sends, "fetchDispatchGroup").mockImplementation(async (db, sendId, key) =>
      (await fetchGroup(db, sendId, key)).map((w) =>
        w.email === "grace@example.com" ? { ...w, unsub_token: null } : w,
      ),
    );
    await toNextTick(env.DB);
    await sweep(env);

    const [lost, resent] = lines().filter((l) => l.event === "send.batch" && l.sendId === send.id);
    expect(lost).toMatchObject({ recipients: 3, held: 3 });
    expect(resent).toMatchObject({ recipients: 3, requests: 1 });
    expect(resent!.unsent).toBeGreaterThanOrEqual(1);
    for (const batch of [lost!, resent!]) {
      const n = (field: string) => batch[field] as number;
      expect(n("accepted") + n("unsent") + n("retried") + n("held") + n("unknown")).toBe(
        n("recipients"),
      );
    }
  });

  it("a provider refusal logs send.halted at warn with the stored retry time, then send.resumed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new ResendLikeProvider();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    // The provider's words may carry an address; the log keeps only its domain.
    provider.refuse = "The newsletter@send.example.com sender is not verified";
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await sweep(env);
    const retryAt = (await sends.getSend(env.DB, send.id))!.halt_retry_at!;
    provider.refuse = null;
    await toNextTick(env.DB);
    await sweep(env);

    expect(eventsFor(send.id)).toEqual([
      "send.fired",
      "send.batch",
      "send.halted",
      "send.batch",
      "send.resumed",
      "send.completed",
    ]);
    const halted = lines().find((l) => l.event === "send.halted")!;
    expect(halted).toMatchObject({ level: "warn", reason: "account", cause: "credentials" });
    expect(halted.error).toBe("The …@send.example.com sender is not verified");
    expect(halted.retryAt).toBe(new Date(retryAt).toISOString());
    expect(lines().find((l) => l.event === "send.batch")).toMatchObject({
      recipients: 3,
      held: 3,
    });
    expectNoAddress();
  });

  it("a request lost on a provider with no key logs send.ambiguous once, then send.wedged each tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new NoKeyProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await sweep(env);
    expect(lines().find((l) => l.event === "send.ambiguous")).toMatchObject({
      level: "error",
      sendId: send.id,
      recipients: 3,
      cause: "no_answer",
    });
    expect(lines().find((l) => l.event === "send.batch")).toMatchObject({
      recipients: 3,
      unknown: 3,
    });

    // Past the threshold, every tick flags the wedged send by name until Resolve.
    vi.setSystemTime(Date.now() + STUCK_THRESHOLD_MS + 60_000);
    await sweep(env);
    await toNextTick(env.DB);
    await sweep(env);
    const wedged = lines().filter((l) => l.event === "send.wedged");
    expect(wedged).toHaveLength(2);
    expect(wedged[0]).toMatchObject({
      level: "error",
      sendId: send.id,
      postId: send.post_id,
      recipients: 3,
    });
    expect(lines().filter((l) => l.event === "send.ambiguous")).toHaveLength(1);
    expect(lines().at(-1)).toMatchObject({ event: "sweep.tick", wedged: 1, stuck: 1 });
    expectNoAddress();
  });

  it("a run that loses its lease says so", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);
    // Another run took the send between this run's hand-off and its check.
    vi.spyOn(sends, "dispatchFresh").mockResolvedValue([]);
    vi.spyOn(sends, "renewLease").mockResolvedValue(false);

    await runSend(env, send.id);

    expect(eventsFor(send.id)).toEqual(["send.fired", "send.lease_lost"]);
    expect(lines().find((l) => l.event === "send.lease_lost")).toMatchObject({ level: "warn" });
  });

  it("a tick that throws logs sweep.error, then its sweep.tick, and still throws", async () => {
    vi.spyOn(sends, "dueSends").mockRejectedValue(new Error("D1 went away"));

    await expect(sweep(env)).rejects.toThrow("D1 went away");

    expect(lines()).toEqual([
      expect.objectContaining({ event: "sweep.error", level: "error", error: "D1 went away" }),
      expect.objectContaining({ event: "sweep.tick", ok: false }),
    ]);
  });

  it("receipts and the suppressions they add are logged per send, as counts", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);
    await sweep(env);
    const { results } = await env.DB.prepare(
      "SELECT email, provider_id FROM deliveries WHERE send_id = ? ORDER BY email",
    )
      .bind(send.id)
      .all<{ email: string; provider_id: string }>();
    for (const spy of spies) {
      spy.mockClear();
    }

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: results[0]!.provider_id },
      { type: "bounced", providerId: results[1]!.provider_id, hard: true },
      { type: "complained", email: "nobody@example.net" },
    ]);

    expect(lines()).toEqual([
      expect.objectContaining({
        event: "receipt.applied",
        sendId: send.id,
        delivered: 1,
        bounced: 1,
        recorded: 2,
      }),
      expect.objectContaining({
        event: "suppression.added",
        sendId: send.id,
        source: "webhook",
        bounce: 1,
      }),
      expect.objectContaining({ event: "receipt.applied", matched: false, complained: 1 }),
      expect.objectContaining({ event: "suppression.added", matched: false, complaint: 1 }),
    ]);
    expectNoAddress();
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain("nobody@");
      }
    }
  });

  it("a cancel is logged against the send", async () => {
    const send = await scheduledSend(Date.now() + 600_000);
    await cancel(env, send.id);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "send.canceled", sendId: send.id, postId: send.post_id }),
    ]);
  });
});

describe("the entry points group a tick's or a request's lines under one run", () => {
  it("the scheduled handler mints a run for the tick", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    const tick = lines().find((l) => l.event === "sweep.tick")!;
    expect(tick.run).toMatch(UUID);
    expect(lines().every((l) => l.run === tick.run)).toBe(true);
  });

  it("a request's run is its cf-ray, and reaches the work it leaves to waitUntil", async () => {
    const provider = new ResendLikeProvider();
    provider.refuse = "ada@example.com: the account is suspended";
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);

    await workerFetch("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-ray": "8c0ffee-LHR" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });

    expect(lines()).toEqual([
      expect.objectContaining({
        event: "subscribe.confirmation_refused",
        level: "warn",
        run: "8c0ffee-LHR",
        error: "…@example.com: the account is suspended",
      }),
    ]);
    expectNoAddress();
  });

  it("a request with no cf-ray gets a run of its own", async () => {
    await workerFetch("/webhooks/resend", { method: "POST", body: "{}" });

    expect(lines()).toEqual([
      expect.objectContaining({
        event: "webhook.received",
        provider: "fake",
        status: 200,
        events: 0,
        run: expect.stringMatching(UUID),
      }),
    ]);
  });
});

describe("the helper", () => {
  it("writes one JSON object a line, at the console method its level names", () => {
    log.warn("send.halted", { sendId: "s1", reason: "account", retries: 2, skipped: undefined });
    const [info, warn] = spies;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      { event: "send.halted", level: "warn", sendId: "s1", reason: "account", retries: 2 },
    ]);
  });

  it("keeps an address's domain and drops its local part, however the address is written", () => {
    expect(scrub("bounce for Ada.L+news@Example.co.uk (hard)")).toBe(
      "bounce for …@Example.co.uk (hard)",
    );
    expect(scrub("ada%40example.com")).toBe("…@example.com");
    expect(scrub("ada%2Bnews%40example.com")).toBe("…@example.com");
    expect(scrub('"ada lovelace"@example.com')).toBe("…@example.com");
    expect(scrub("ada@exämple.com")).toBe("…@exämple.com");
    expect(scrub("ada@[192.0.2.1]")).toBe("…@[192.0.2.1]");
    expect(scrub("mailto:ada@localhost")).toBe("mailto:…@localhost");
    expect(scrub("no address here")).toBe("no address here");
    // A package path in a stack is not an address.
    expect(scrub("at node_modules/@cloudflare/x.js:1")).toBe("at node_modules/@cloudflare/x.js:1");
  });

  it("removes the token from a reader's link, which would act as the reader", () => {
    expect(scrub("bad URL https://k.test/unsubscribe?token=uns-abc123&x=1")).toBe(
      "bad URL https://k.test/unsubscribe?token=…&x=1",
    );
    expect(scrub("/confirm?TOKEN=abc")).toBe("/confirm?TOKEN=…");
  });

  it("never throws, whatever the console does", () => {
    spies[0]!.mockImplementation(() => {
      throw new Error("console gone");
    });
    expect(() => log.info("sweep.tick")).not.toThrow();
  });
});
