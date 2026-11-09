import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import worker from "../src/index";
import { isD1Stall } from "../src/lib/d1_stall";
import { log, scrub, withRun } from "../src/lib/log";
import { STUCK_THRESHOLD_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { cancel } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { BatchProvider } from "./support/batching";
import { toNextTick } from "./support/clock";
import { failingD1 } from "./support/d1_failure";
import { SES_DEPLOY } from "./support/deploy";
import {
  dueSend,
  frozenSend,
  resetDatabase,
  SEEDED_SEND_ID,
  seedConfirmed,
  seedDelivery,
  sendingWorks,
} from "./support/fixtures";
import { allowErrorLogs, type LoggedLine, logged } from "./support/log";
import { fetchWith, withVars } from "./support/worker_env";

// The structured log (SPEC §12): every line one JSON object, a send's lifecycle in order
// under its sendId, the lines of a tick or a request under one run, and never a
// recipient's address or token in any line.

const AUDIENCE = ["ada@example.com", "grace@example.com", "linus@example.org"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  clearFakeOutbox();
  spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A failure the app doesn't recognize as anything in particular. */
const REFUSED = "D1_ERROR: the database refused the query";
/** The words D1 gives for a stall: an internal error, and a reference to it. */
const STALL = "D1_ERROR: internal error; reference = abc123def456";

/** The suite's env under `vars`, on a database whose statements matching `sql` fail. */
function failingOn(sql: RegExp, message: string, vars: Record<string, string> = {}): AppEnv {
  return { ...withVars(vars), DB: failingD1(env.DB, sql, message) };
}

describe("the send lifecycle in the log", () => {
  it("a send through the sweep logs fired, batch, completed in order under its sendId, and no address", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();
    // Only the tick's own lines: scheduling the send came before it.
    for (const spy of spies) {
      spy.mockClear();
    }

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

  it("a batch's counts add up to its recipients when its answer is lost", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new BatchProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();
    // The request's answer is lost, so every member's fate is unknown, and the batch waits
    // for Resolve. Every member is still counted once.
    await sweep(env);

    const [lost] = lines().filter((l) => l.event === "send.batch" && l.sendId === send.id);
    expect(lost).toMatchObject({ recipients: 3, unknown: 3 });
    const n = (field: string) => lost![field] as number;
    expect(n("accepted") + n("unsent") + n("retried") + n("held") + n("unknown")).toBe(
      n("recipients"),
    );
  });

  it("a provider refusal logs send.halted at warn with the stored retry time, then send.resumed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new BatchProvider();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    // The provider's words may carry an address; the log keeps only its domain.
    provider.refuse = "The newsletter@send.example.com sender is not verified";
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await sweep(env);
    const retryAt = (await sends.getSend(env.DB, send.id))!.halt_retry_at!;
    provider.refuse = null;
    await toNextTick(env.DB);
    await sweep(env);

    // The refusal begins with this send, so the operator's alert line is its own, before
    // the writes that follow the answer (SPEC §12).
    expect(eventsFor(send.id)).toEqual([
      "send.scheduled",
      "send.fired",
      "alert.sending",
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

  it("a refusal whose words echo the signing credential logs send.halted without it", async () => {
    const provider = new BatchProvider();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    // The adapter redacts SES's words; the logger redacts again, so no provider's can leak.
    provider.refuse =
      "IncompleteSignatureException: Authorization=AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261016/us-east-1/ses/aws4_request, SignedHeaders=host, Signature=5d672d79c15b13162d9279b0855cfba6";
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await sweep(env);

    const halted = lines().find((l) => l.event === "send.halted" && l.sendId === send.id)!;
    expect(halted.error).toBe(
      "IncompleteSignatureException: Authorization=AWS4-HMAC-SHA256 Credential=…, SignedHeaders=host, Signature=…",
    );
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(call.map(String).join(" ")).not.toMatch(/AKIAIOSFODNN7EXAMPLE|5d672d79/);
      }
    }
  });

  it("a request lost on a provider with no key logs send.ambiguous once, then send.wedged each tick from the one that left it", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new BatchProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

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

    // Wedged from the tick whose run left it, and flagged by name every tick until Resolve.
    expect(lines().filter((l) => l.event === "send.wedged")).toHaveLength(1);
    vi.setSystemTime(Date.now() + STUCK_THRESHOLD_MS + 60_000);
    await sweep(env);
    await toNextTick(env.DB);
    await sweep(env);
    const wedged = lines().filter((l) => l.event === "send.wedged");
    expect(wedged).toHaveLength(3);
    expect(wedged[0]).toMatchObject({
      level: "error",
      sendId: send.id,
      postId: send.post_id,
      recipients: 3,
    });
    expect(lines().filter((l) => l.event === "send.ambiguous")).toHaveLength(1);
    // Waiting on Resolve, never in flight too long, however long it waits (SPEC §12).
    expect(lines().filter((l) => l.event === "send.stuck")).toHaveLength(0);
    expect(lines().at(-1)).toMatchObject({ event: "sweep.tick", wedged: 1, stuck: 0 });
    expectNoAddress();
  });

  it("a run that loses its lease says so", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();
    // Another run took the send between this run's hand-off and its check.
    vi.spyOn(sends, "dispatchFresh").mockResolvedValue([]);
    vi.spyOn(sends, "renewLease").mockResolvedValue(false);

    await runSend(env, send.id);

    expect(eventsFor(send.id)).toEqual(["send.scheduled", "send.fired", "send.lease_lost"]);
    expect(lines().find((l) => l.event === "send.lease_lost")).toMatchObject({ level: "warn" });
  });

  it("a tick that throws logs sweep.error, then its sweep.tick, and still throws", async () => {
    allowErrorLogs("sweep.error");
    vi.spyOn(sends, "dueSends").mockRejectedValue(new Error("D1 went away"));

    await expect(sweep(env)).rejects.toThrow("D1 went away");

    expect(lines()).toEqual([
      expect.objectContaining({ event: "sweep.error", level: "error", error: "D1 went away" }),
      expect.objectContaining({ event: "sweep.tick", ok: false }),
    ]);
  });

  it("receipts, the suppressions they add, and the complaints are logged per send, as counts (SPEC §12)", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();
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
        count: 1,
      }),
      expect.objectContaining({ event: "receipt.applied", matched: false, complained: 1 }),
      expect.objectContaining({
        event: "subscriber.complained",
        matched: false,
        count: 1,
        no_subscriber: 1,
      }),
    ]);
    expectNoAddress();
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain("nobody@");
      }
    }
  });

  it("a schedule and its cancel are logged against the send", async () => {
    const send = await frozenSend(Date.now() + 600_000);
    await cancel(env, send.id);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "send.scheduled", sendId: send.id, postId: send.post_id }),
      expect.objectContaining({ event: "send.canceled", sendId: send.id, postId: send.post_id }),
    ]);
  });
});

describe("a database failure the sweep catches names the statement that failed (SPEC §12)", () => {
  it.each([
    { event: "sweep.error", vars: {}, sql: /status = 'scheduled'/, statement: "dueSends" },
    {
      event: "receipt.release_error",
      vars: {},
      sql: /FROM held_receipts h/,
      statement: "heldReceipts",
    },
    {
      event: "notify.error",
      vars: {},
      sql: /INSERT OR IGNORE INTO notifications/,
      statement: "recordNotifications",
    },
    {
      event: "provider.account_error",
      vars: SES_DEPLOY,
      sql: /FROM provider_account/,
      statement: "readProviderAccount",
    },
  ])("$event carries a stack through $statement", async ({ event, vars, sql, statement }) => {
    allowErrorLogs(event);

    await sweep(failingOn(sql, REFUSED, vars)).catch(() => undefined);

    const line = lines().find((l) => l.event === event)!;
    expect(line.error).toBe(REFUSED);
    expect(line.stack).toContain(statement);
  });

  it("send.error carries a stack too, since a send's own failure is the one most worth placing", async () => {
    allowErrorLogs("send.error");
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await sweep(failingOn(/UPDATE deliveries SET status = 'dispatched'/, REFUSED));

    const line = lines().find((l) => l.event === "send.error")!;
    expect(line.sendId).toBe(send.id);
    expect(line.stack).toContain("dispatchFresh");
  });

  it("sending.record_failed carries a stack through the write it couldn't make", async () => {
    allowErrorLogs("sending.record_failed");
    await seedConfirmed(AUDIENCE);
    await dueSend();

    await sweep(failingOn(/INSERT INTO sending/, REFUSED));

    const line = lines().find((l) => l.event === "sending.record_failed")!;
    expect(line).toMatchObject({ purpose: "list", error: REFUSED });
    expect(line.stack).toContain("recordAccepted");
  });

  it("provider.pacing_unread carries a stack through the read it couldn't make", async () => {
    vi.spyOn(providers, "getProvider").mockReturnValue(new BatchProvider());
    await seedConfirmed(AUDIENCE);
    await dueSend();

    await sweep(failingOn(/FROM provider_account/, REFUSED, SES_DEPLOY));

    const line = lines().find((l) => l.event === "provider.pacing_unread")!;
    expect(line).toMatchObject({ level: "warn", error: REFUSED });
    expect(line.stack).toContain("readProviderAccount");
  });

  it("scrubs the stack as it scrubs any field: no address, token, or credential gets through (§9)", async () => {
    allowErrorLogs("notify.error");
    const words =
      "D1_ERROR: bad row for ada@example.com at /unsubscribe?token=uns-abc123 with Credential=AKIAIOSFODNN7EXAMPLE/20261016/us-east-1/ses/aws4_request";

    await sweep(failingOn(/INSERT OR IGNORE INTO notifications/, words));

    const line = lines().find((l) => l.event === "notify.error")!;
    expect(line.stack).toContain("D1_ERROR: bad row for …@example.com");
    expect(line.stack).toContain("recordNotifications");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(call.map(String).join(" ")).not.toMatch(/ada@|uns-abc123|AKIAIOSFODNN7EXAMPLE/);
      }
    }
  });

  it("a thrown value with no stack logs the line without the field", async () => {
    allowErrorLogs("sweep.error");
    vi.spyOn(sends, "dueSends").mockRejectedValue("not an error");

    await expect(sweep(env)).rejects.toBe("not an error");

    const line = lines().find((l) => l.event === "sweep.error")!;
    expect(line.error).toBe("not an error");
    expect(line).not.toHaveProperty("stack");
  });
});

describe("a database stall the next tick makes up for is a warning (SPEC §12)", () => {
  const PLACES = [
    {
      during: "sweep",
      event: "sweep.error",
      vars: {},
      sql: /status = 'scheduled'/,
      statement: "dueSends",
      ok: false,
    },
    {
      during: "receipts",
      event: "receipt.release_error",
      vars: {},
      sql: /FROM held_receipts h/,
      statement: "heldReceipts",
      ok: true,
    },
    {
      during: "notify",
      event: "notify.error",
      vars: {},
      sql: /INSERT OR IGNORE INTO notifications/,
      statement: "recordNotifications",
      ok: true,
    },
    {
      during: "account",
      event: "provider.account_error",
      vars: SES_DEPLOY,
      sql: /FROM provider_account/,
      statement: "readProviderAccount",
      ok: true,
    },
  ];

  it.each(PLACES)(
    "a stall during $during logs d1.unavailable at warn, and the tick doesn't throw",
    async ({ during, vars, sql, statement, ok }) => {
      // No allowErrorLogs: an error line from any of these fails the test.
      await expect(sweep(failingOn(sql, STALL, vars))).resolves.toBeUndefined();

      const all = lines();
      const line = all.find((l) => l.event === "d1.unavailable")!;
      expect(line).toMatchObject({ level: "warn", during, error: STALL });
      expect(line.stack).toContain(statement);
      expect(all.filter((l) => l.level === "error")).toEqual([]);
      expect(all.at(-1)).toMatchObject({ event: "sweep.tick", ok });
    },
  );

  it.each(PLACES)(
    "any other failure during $during still logs $event at error",
    async ({ event, vars, sql, ok }) => {
      allowErrorLogs(event);

      const tick = sweep(failingOn(sql, REFUSED, vars));

      // A failure in the sweep itself still throws; a step's is caught, as it always was.
      await (ok ? expect(tick).resolves.toBeUndefined() : expect(tick).rejects.toThrow(REFUSED));
      expect(lines().find((l) => l.event === event)).toMatchObject({
        level: "error",
        error: REFUSED,
      });
      expect(lines().filter((l) => l.event === "d1.unavailable")).toEqual([]);
    },
  );

  it("the invocation shows no exception for a stall, and still shows one for any other failure", async () => {
    allowErrorLogs("sweep.error");
    const invoke = async (message: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(
        {} as ScheduledController,
        failingOn(/status = 'scheduled'/, message),
        ctx,
      );
      return waitOnExecutionContext(ctx);
    };

    await expect(invoke(STALL)).resolves.toBeUndefined();
    await expect(invoke(REFUSED)).rejects.toThrow(REFUSED);
  });

  it("a stall during a send stays send.error at error: it can leave recipients waiting on Resolve", async () => {
    allowErrorLogs("send.error");
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await sweep(failingOn(/UPDATE deliveries SET status = 'dispatched'/, STALL));

    expect(lines().find((l) => l.event === "send.error")).toMatchObject({
      level: "error",
      sendId: send.id,
      error: STALL,
    });
    expect(lines().filter((l) => l.event === "d1.unavailable")).toEqual([]);
  });

  it("a stall recording whether email is getting out stays an error: nothing asks the provider again", async () => {
    allowErrorLogs("sending.record_failed");
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await expect(sweep(failingOn(/INSERT INTO sending/, STALL))).resolves.toBeUndefined();

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(lines().find((l) => l.event === "sending.record_failed")).toMatchObject({
      level: "error",
      error: STALL,
    });
    expect(lines().filter((l) => l.event === "d1.unavailable")).toEqual([]);
  });

  it("a held receipt a stall interrupted lands once on the next tick, with its counts unmoved", async () => {
    await seedDelivery("held@example.com", null);
    await env.DB.prepare("UPDATE deliveries SET status = 'dispatched'").run();
    await applyDeliveryEvents(env.DB, [
      { type: "bounced", providerId: "msg-lost", email: "held@example.com", hard: false },
    ]);
    // Resolve's "assume sent", so the pass applies the receipt.
    await env.DB.prepare("UPDATE deliveries SET status = 'accepted'").run();
    const held = () => env.DB.prepare("SELECT COUNT(*) AS n FROM held_receipts").first<number>("n");
    const events = () => env.DB.prepare("SELECT event, bounce_kind FROM deliveries").all();
    const counters = () => sends.getSend(env.DB, SEEDED_SEND_ID);
    expect(await held()).toBe(1);

    // The worst moment: the receipt landed, and the write releasing it never answered.
    await sweep(failingOn(/DELETE FROM held_receipts/, STALL));

    expect(lines().find((l) => l.event === "d1.unavailable")).toMatchObject({
      during: "receipts",
      level: "warn",
    });
    expect(await held()).toBe(1);
    const landed = (await events()).results;
    expect(landed).toEqual([{ event: "bounced", bounce_kind: "soft" }]);
    const before = await counters();

    await sweep(env);

    expect(await held()).toBe(0);
    expect((await events()).results).toEqual(landed);
    expect(await counters()).toEqual(before);
  });

  it("a stall that keeps a send from firing leaves it scheduled, and the next tick fires it", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await dueSend();

    await sweep(failingOn(/status = 'scheduled'/, STALL));
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("scheduled");
    expect(fakeOutbox()).toEqual([]);

    await sweep(env);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(
      fakeOutbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual(AUDIENCE);
  });

  it("recognizes only the words D1 gives for a stall, so changed wording stays an error", () => {
    expect(isD1Stall(new Error(STALL))).toBe(true);
    for (const other of [
      REFUSED,
      "D1_ERROR: internal error",
      "D1_ERROR: Internal Error; reference = abc123def456",
      "internal error; reference = abc123def456",
      `sending failed: ${STALL}`,
    ]) {
      expect(isD1Stall(new Error(other))).toBe(false);
    }
    expect(isD1Stall(undefined)).toBe(false);
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
    const provider = new BatchProvider();
    provider.refuse = "ada@example.com: the account is suspended";
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);

    await fetchWith({}, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-ray": "8c0ffee-LHR" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });

    expect(lines()).toEqual([
      // The operator's alert line first, then whether email is getting out, recorded in the
      // same run (SPEC §12, §13).
      expect.objectContaining({
        event: "alert.sending",
        level: "warn",
        run: "8c0ffee-LHR",
        cause: "credentials",
      }),
      expect.objectContaining({
        event: "sending.refusing",
        level: "warn",
        run: "8c0ffee-LHR",
        cause: "credentials",
      }),
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
    await fetchWith({}, "/webhooks/ses", { method: "POST", body: "{}" });

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

  it("removes an AWS credential a signature error echoes, and any access key ID", () => {
    expect(
      scrub(
        "Credential=AKIAIOSFODNN7EXAMPLE/20261016/us-east-1/ses/aws4_request, SignedHeaders=host, Signature=deadbeef01",
      ),
    ).toBe("Credential=…, SignedHeaders=host, Signature=…");
    expect(scrub("key ASIAIOSFODNN7EXAMPLE was refused")).toBe("key … was refused");
    expect(scrub("x-amz-security-token:IQoJb3JpZ2luX2Vj\nhost")).toBe(
      "x-amz-security-token:…\nhost",
    );
    expect(scrub("?X-Amz-Security-Token=IQoJ%2Fb3&X-Amz-Date=1")).toBe(
      "?X-Amz-Security-Token=…&X-Amz-Date=1",
    );
    // An ordinary word that merely starts the same is not a key.
    expect(scrub("AKIA is a key prefix")).toBe("AKIA is a key prefix");
  });

  it("never throws, whatever the console does", () => {
    spies[0]!.mockImplementation(() => {
      throw new Error("console gone");
    });
    expect(() => log.info("sweep.tick")).not.toThrow();
  });
});
