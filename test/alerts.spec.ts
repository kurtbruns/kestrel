import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { readSending, recordAccepted } from "../src/db/sending";
import { getSettings } from "../src/db/settings";
import { getConfig } from "../src/env";
import * as providers from "../src/providers";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { Budget } from "../src/send/budget";
import { runSend } from "../src/send/loop";
import { sweep } from "../src/send/sweep";
import { refreshProviderAccount } from "../src/services/provider_status";
import { noteRefusal } from "../src/services/sending";
import { BatchProvider } from "./support/batching";
import { failingD1 } from "./support/d1_failure";
import { dueSend, resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { type LoggedLine, logged } from "./support/log";
import { withVars } from "./support/worker_env";

// The two log lines operators' Cloudflare Monitors alert on (SPEC §12): `alert.sending`, with a
// `cause`, once when email stops getting out, and `sweep.tick`, with `ok`, every tick. The
// Monitors' queries name these events and fields as written here, so renaming either breaks
// every operator's alert silently; these tests are what fails first. The alert email comes
// from the line, so a line repeated while a refusal stands would mail the operator again.

const FAILED = "D1_ERROR: the database refused the query";
const QUOTA = "ses 429 LimitExceededException: Daily message quota exceeded.";
const NO_SET = "ses 400 ConfigurationSetDoesNotExist";

/** A provider that takes the first recipient of each batch and holds the rest back with `halt`,
 *  so the answer has outcomes to settle and a hold to write. */
function takesOneThenHalts(cause: "quota" | "configuration", error: string): BatchProvider {
  const transport = new BatchProvider();
  let taken = 0;
  vi.spyOn(transport, "sendBatch").mockImplementation(async (_r, recipients) => ({
    kind: "answered",
    results: recipients.map((r, i) =>
      i === 0
        ? { email: r.email, accepted: true, providerId: `msg_${++taken}` }
        : { email: r.email, accepted: false, retryable: true, held: true, error },
    ),
    halt: { reason: "account", cause, error },
  }));
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
  return transport;
}

/** Note a refusal of the account found by a test email, with `cause`, at `at`. */
const refuse = (cause: "configuration" | "credentials", at = Date.now()) =>
  noteRefusal(env.DB, { cause, foundBy: "test", error: `ses refused: ${cause}` }, at, false);

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

  it.each([
    ["settles the answer", /provider_id = COALESCE/],
    ["holds the send", /halt_reason = \?/],
  ])(
    "a send halted on its quota logs alert.sending with cause quota, even when the write that %s fails",
    async (_what, failing) => {
      await seedConfirmed(["ada@example.com", "grace@example.com"]);
      const send = await dueSend();
      // SES taking one and holding the other back for the daily quota.
      takesOneThenHalts("quota", QUOTA);

      const broken = { ...env, DB: failingD1(env.DB, failing, FAILED) };
      await expect(runSend(broken, send.id)).rejects.toThrow(FAILED);
      expect(alerts()).toEqual([
        expect.objectContaining({
          event: "alert.sending",
          level: "warn",
          cause: "quota",
          sendId: send.id,
        }),
      ]);
    },
  );
});

describe("one alert when a refusal begins, none while it stands (SPEC §12)", () => {
  it("a refusal noted twice with the same cause logs one alert.sending", async () => {
    await refuse("configuration");
    await refuse("configuration", Date.now() + 1);
    expect(alerts()).toHaveLength(1);
    // Both were recorded: only the alert is once.
    expect(lines().filter((l) => l.event === "sending.refusing")).toHaveLength(2);
  });

  it("a refusal whose cause changes is a new refusal, and logs a second", async () => {
    await refuse("configuration");
    await refuse("credentials", Date.now() + 1);
    expect(alerts().map((l) => l.cause)).toEqual(["configuration", "credentials"]);
  });

  it("a refusal that begins after sending recovered logs again", async () => {
    const at = Date.now();
    await refuse("configuration", at);
    await recordAccepted(env.DB, "test", at + 1);
    await refuse("configuration", at + 2);
    expect(alerts()).toHaveLength(2);
  });

  it("the account check finding the same refusal at each check logs one, and none while an email's refusal stands", async () => {
    const e = withVars({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: "production:set_missing" });
    const check = () => refreshProviderAccount(e, getConfig(e), new Budget(50), Date.now());
    await check();
    await check();
    await check();
    expect(alerts()).toEqual([
      expect.objectContaining({ cause: "configuration", foundBy: "account_check" }),
    ]);

    // An email met the same refusal first: the checks that follow find it standing.
    await resetDatabase();
    for (const s of spies) {
      s.mockClear();
    }
    await refuse("configuration");
    await check();
    await check();
    expect(alerts()).toEqual([expect.objectContaining({ foundBy: "test" })]);
  });

  it("a list send's refusal logs one alert.sending in all, before the send's writes, and none at its retry", async () => {
    await seedConfirmed(["ada@example.com", "grace@example.com"]);
    const send = await dueSend();
    takesOneThenHalts("configuration", NO_SET);

    // The sweep runs the send, then records what it met: the loop alerted, the record doesn't.
    await sweep(env);
    expect(alerts()).toEqual([
      expect.objectContaining({ cause: "configuration", foundBy: "list", sendId: send.id }),
    ]);
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalCause: "configuration",
    });

    // Its retry meets the same refusal, which still stands.
    await runSend(env, send.id);
    expect(alerts()).toHaveLength(1);
  });

  it("a list send's refusal is logged even when the write that settles the answer fails", async () => {
    await seedConfirmed(["ada@example.com", "grace@example.com"]);
    const send = await dueSend();
    takesOneThenHalts("configuration", NO_SET);

    const broken = { ...env, DB: failingD1(env.DB, /provider_id = COALESCE/, FAILED) };
    await expect(runSend(broken, send.id)).rejects.toThrow(FAILED);
    expect(alerts()).toEqual([
      expect.objectContaining({ cause: "configuration", foundBy: "list", sendId: send.id }),
    ]);
  });

  it("a send still over its quota at its retry logs no second alert.sending", async () => {
    await seedConfirmed(["ada@example.com", "grace@example.com", "alan@example.com"]);
    const send = await dueSend();
    takesOneThenHalts("quota", QUOTA);

    await runSend(env, send.id);
    await runSend(env, send.id);
    expect(alerts()).toEqual([expect.objectContaining({ cause: "quota", sendId: send.id })]);
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
