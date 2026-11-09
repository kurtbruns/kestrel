import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import { LONG_OUTAGE_HALTS } from "../src/lib/time";
import { clearFakeNotifications, failFakeNotify, fakeNotifications } from "../src/notify/fake";
import * as providers from "../src/providers";
import type { SendBatchResult } from "../src/providers/types";
import { BatchProvider } from "./support/batching";
import { condition } from "./support/conditions";
import {
  addresses,
  dueSend,
  resetDatabase,
  seedConfirmed,
  sendingWorks,
  tick,
  ticks,
} from "./support/fixtures";
import { type LoggedLine, logged } from "./support/log";
import { viewOf } from "./support/view";

// A provider outage past an hour (SPEC §8, §12): once a send has met the provider unavailable at
// every retry of its backoff, about an hour, the publisher is emailed once, the send's notice is
// worth a look, and the operator's alert line is written once, with cause `outage`. None of it
// repeats at the hourly retries, and a later outage, after the provider answered, is a new one.

const PUBLISHER = "publisher@example.com";
const DOWN: SendBatchResult = {
  kind: "halted",
  halt: { reason: "unavailable", cause: "outage", error: "ses 503 ServiceUnavailable" },
};

/** A provider that takes one recipient a request, so a send of a few spans several runs. */
class OneAtATime extends BatchProvider {
  override readonly maxBatch = 1;
}

let transport: BatchProvider;
let spies: MockInstance[] = [];
const alerts = (): LoggedLine[] => logged(...spies).filter((l) => l.event === "alert.sending");
const told = () => fakeNotifications().filter((n) => n.subject.includes("is late"));

async function rowsOf(kind: string) {
  const { results } = await env.DB.prepare(
    "SELECT send_id, episode, status FROM notifications WHERE kind = ? ORDER BY created_at",
  )
    .bind(kind)
    .all<{ send_id: string; episode: number; status: string }>();
  return results;
}

async function provider(sendId: string) {
  const row = (await sends.getSend(env.DB, sendId))!;
  return condition(viewOf(row, "ses", false, Date.now()), "provider_unavailable");
}

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  await updateSettings(env.DB, { notifications: { to: [PUBLISHER] } });
  clearFakeNotifications();
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
  spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a provider outage past an hour (SPEC §8, §12)", () => {
  it("a one-minute blip is never emailed and logs no alert.sending", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.outage = 1;

    await ticks(3);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(alerts()).toEqual([]);
    expect(told()).toEqual([]);
    expect(await rowsOf("unavailable")).toEqual([]);
  });

  it("is emailed once and alerted once, with cause outage, about an hour in, and not again at each hourly retry", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.outage = 1_000;

    // Every halt short of the hourly step: shown in grey, told to no one.
    await ticks(LONG_OUTAGE_HALTS - 1);
    expect(alerts()).toEqual([]);
    expect(told()).toEqual([]);
    expect((await provider(send.id))?.severity).toBe("info");

    // The halt that makes the next retry an hour away.
    await tick();
    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.halt_retries).toBe(LONG_OUTAGE_HALTS);
    expect(Math.round((Date.now() - row.halted_at!) / 60_000)).toBe(53);
    expect(alerts()).toEqual([
      expect.objectContaining({ level: "warn", cause: "outage", sendId: send.id }),
    ]);
    expect(told()).toHaveLength(1);
    const email = told()[0]!;
    expect(email.to).toBe(PUBLISHER);
    expect(email.text).toContain("Nothing is lost.");
    expect(email.text).toContain("tries again every hour and carries on by itself");
    expect(email.text).toContain("https://health.aws.amazon.com/health/status");
    expect(email.text).toContain("tell your readers it will be late");
    expect(email.text).toContain(
      "Notifications go through SES too, so this email may have arrived late.",
    );
    expect(email.text).toContain("SES said: ses 503 ServiceUnavailable");
    // The page says it at the same moment, amber.
    const shown = await provider(send.id);
    expect(shown?.severity).toBe("warn");
    expect(shown?.message).toContain("unavailable for over an hour");

    // Three hourly retries later, still down: nothing more.
    await ticks(3);
    expect((await sends.getSend(env.DB, send.id))!.halt_retries).toBe(LONG_OUTAGE_HALTS + 3);
    expect(alerts()).toHaveLength(1);
    expect(told()).toHaveLength(1);
    expect(await rowsOf("unavailable")).toEqual([
      { send_id: send.id, episode: row.halted_at, status: "sent" },
    ]);
  });

  it("a second outage, after the provider answered, is emailed and alerted again", async () => {
    transport = new OneAtATime();
    vi.spyOn(providers, "getProvider").mockReturnValue(transport);
    let down = true;
    const answer = transport.sendBatch.bind(transport);
    vi.spyOn(transport, "sendBatch").mockImplementation(async (rendered, recipients, opts) => {
      if (down) {
        return DOWN;
      }
      down = true; // answers one request, then goes down again
      return answer(rendered, recipients, opts);
    });
    await seedConfirmed(addresses(4));
    const send = await dueSend();

    await ticks(LONG_OUTAGE_HALTS);
    const first = (await sends.getSend(env.DB, send.id))!.halted_at!;
    expect(alerts()).toHaveLength(1);
    expect(told()).toHaveLength(1);

    // The provider takes one, then is down again: the outage ended, and a new one began.
    down = false;
    await tick();
    const second = (await sends.getSend(env.DB, send.id))!;
    expect(second.c_accepted).toBe(1);
    expect(second.halt_retries).toBe(1);
    expect(second.halted_at).not.toBe(first);
    expect((await provider(send.id))?.severity).toBe("info");

    await ticks(LONG_OUTAGE_HALTS - 1);
    expect(alerts().map((l) => l.cause)).toEqual(["outage", "outage"]);
    expect(told()).toHaveLength(2);
    expect((await rowsOf("unavailable")).map((r) => r.episode)).toEqual([first, second.halted_at]);
  });

  it("an answer that took someone ends the outage, so the halts before it never add up to the hour", async () => {
    transport = new OneAtATime();
    vi.spyOn(providers, "getProvider").mockReturnValue(transport);
    let down = true;
    const answer = transport.sendBatch.bind(transport);
    vi.spyOn(transport, "sendBatch").mockImplementation(async (rendered, recipients, opts) => {
      if (down) {
        return DOWN;
      }
      down = true;
      return answer(rendered, recipients, opts);
    });
    await seedConfirmed(addresses(4));
    const send = await dueSend();

    // One halt short of the hour, then the provider takes one and is down again at once.
    await ticks(LONG_OUTAGE_HALTS - 1);
    down = false;
    await tick();

    expect((await sends.getSend(env.DB, send.id))!.halt_retries).toBe(1);
    expect(alerts()).toEqual([]);
    expect(told()).toEqual([]);
  });

  it("an email not yet sent when the outage clears is dropped", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.outage = LONG_OUTAGE_HALTS;

    await ticks(LONG_OUTAGE_HALTS - 1);
    // The channel fails on the tick the outage passes the hour.
    failFakeNotify(1);
    await tick();
    expect(alerts()).toHaveLength(1);
    expect(await rowsOf("unavailable")).toMatchObject([{ status: "pending" }]);

    // An hour on, the provider answers before the email gets through.
    await tick();
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(told()).toEqual([]);
    expect(await rowsOf("unavailable")).toMatchObject([{ status: "cleared" }]);
    expect(fakeNotifications().map((n) => n.subject)).toEqual([expect.stringMatching(/^Sent: /)]);
  });

  it("is told for one send however many wait out the same outage", async () => {
    await seedConfirmed(addresses(3));
    const a = await dueSend();
    const b = await dueSend();
    transport.outage = 1_000;

    await ticks(LONG_OUTAGE_HALTS + 2);

    expect((await sends.getSend(env.DB, b.id))!.halt_reason).toBe("unavailable");
    expect((await provider(a.id))?.severity).toBe("warn");
    expect((await provider(b.id))?.severity).toBe("warn");
    expect(alerts()).toHaveLength(1);
    expect(told()).toHaveLength(1);
    expect(await rowsOf("unavailable")).toHaveLength(1);
  });

  it("a rate limit that lasts the hour says the setting that causes it, not the status page", async () => {
    await seedConfirmed(addresses(3));
    await dueSend();
    transport.rateLimit = 1_000;

    await ticks(LONG_OUTAGE_HALTS);

    expect(told()).toHaveLength(1);
    expect(told()[0]!.text).toContain("SES_MAX_SEND_RATE");
    expect(told()[0]!.text).not.toContain("health.aws.amazon.com");
  });
});
