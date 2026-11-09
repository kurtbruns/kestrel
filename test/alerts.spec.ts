import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { readSending } from "../src/db/sending";
import { getSettings } from "../src/db/settings";
import * as providers from "../src/providers";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { sweep } from "../src/send/sweep";
import { noteRefusal } from "../src/services/sending";
import { BatchProvider } from "./support/batching";
import { failingD1 } from "./support/d1_failure";
import { dueSend, resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { type LoggedLine, logged } from "./support/log";

// The two log lines operators' Cloudflare Monitors alert on (SPEC §12): `alert.sending`, with a
// `cause`, whenever email can't get out, and `sweep.tick`, with `ok`, every tick. The Monitors'
// queries name these events and fields as written here, so renaming either breaks every
// operator's alert silently; these tests are what fails first.

const FAILED = "D1_ERROR: the database refused the query";

let spies: MockInstance[] = [];
const lines = (): LoggedLine[] => logged(...spies);
const alerts = () => lines().filter((l) => l.event === "alert.sending");

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  clearFakeOutbox();
  spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the lines operators' alerts depend on (SPEC §12)", () => {
  it("every sweep tick logs sweep.tick with ok true", async () => {
    await sweep(env);
    const tick = lines().filter((l) => l.event === "sweep.tick");
    expect(tick).toHaveLength(1);
    expect(tick[0]).toMatchObject({ event: "sweep.tick", ok: true });
  });

  it("a refusal of the account logs alert.sending with its cause, even when the database then fails the write", async () => {
    const db = failingD1(env.DB, /sending/i, FAILED);
    await expect(
      noteRefusal(
        db,
        { cause: "configuration", foundBy: "test", error: "ses 400 ConfigurationSetDoesNotExist" },
        Date.now(),
        false,
      ),
    ).rejects.toThrow(FAILED);
    expect(alerts()).toEqual([
      expect.objectContaining({
        event: "alert.sending",
        level: "warn",
        cause: "configuration",
        foundBy: "test",
      }),
    ]);
  });

  it("a send halted on its quota logs alert.sending with cause quota, before the hold is written", async () => {
    await seedConfirmed(["ada@example.com", "grace@example.com"]);
    const send = await dueSend();
    const transport = new BatchProvider();
    transport.refuse = "ses 429 LimitExceededException: Daily message quota exceeded.";
    transport.refuseCause = "quota";
    vi.spyOn(providers, "getProvider").mockReturnValue(transport);

    const failing = { ...env, DB: failingD1(env.DB, /halt_reason = \?/, FAILED) };
    await expect(runSend(failing, send.id)).rejects.toThrow(FAILED);
    expect(alerts()).toEqual([
      expect.objectContaining({
        event: "alert.sending",
        level: "warn",
        cause: "quota",
        sendId: send.id,
      }),
    ]);
  });
});

describe("Send a test alert (SPEC §12)", () => {
  it("logs alert.sending with cause test, and changes nothing and mails no one", async () => {
    const settingsBefore = await getSettings(env.DB);
    const sendingBefore = await readSending(env.DB);

    const res = await SELF.fetch(`${base}/api/settings/notifications/alert-test`, {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: string; cause: string; at: number };
    expect(body).toMatchObject({ event: "alert.sending", cause: "test" });
    expect(typeof body.at).toBe("number");
    expect(alerts()).toEqual([
      expect.objectContaining({ event: "alert.sending", level: "warn", cause: "test" }),
    ]);
    expect(await getSettings(env.DB)).toEqual(settingsBefore);
    expect(await readSending(env.DB)).toEqual(sendingBefore);
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("is an admin route: no credential, no line", async () => {
    const res = await SELF.fetch(`${base}/api/settings/notifications/alert-test`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(alerts()).toEqual([]);
  });
});
