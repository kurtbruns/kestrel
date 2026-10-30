/**
 * Whether email is getting out (SPEC §9): which answers make it refusing and which don't,
 * that an email the provider takes makes it working, that every kind of email writes it, and
 * that the account check pauses signups and lifts only a pause it caused.
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSING_CAUSES } from "../shared/provider";
import type { HaltCause } from "../shared/sends";
import { readSending, recordAccepted } from "../src/db/sending";
import { type AppEnv, getConfig } from "../src/env";
import { fakeNotifications } from "../src/notify/fake";
import * as providers from "../src/providers";
import type { SendBatchResult } from "../src/providers/types";
import { contactOutcome, noteContact, readSignups } from "../src/services/sending";
import { BatchProvider } from "./support/batching";
import { dueSend, resetDatabase, seedConfirmed, tick } from "./support/fixtures";
import { withVars } from "./support/worker_env";

const config = getConfig(env);

const halted = (
  cause: HaltCause,
  reason: "account" | "unavailable" = "account",
): SendBatchResult => ({
  kind: "halted",
  halt: { reason, cause, error: `ses refused: ${cause}` },
});

const accepted: SendBatchResult = {
  kind: "answered",
  results: [{ email: "a@example.com", accepted: true, providerId: "m1" }],
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await resetDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what makes email refusing (SPEC §9)", () => {
  it.each(REFUSING_CAUSES)("a refusal for %s does", async (cause) => {
    await noteContact(env.DB, config, "test", contactOutcome(halted(cause)), Date.now());
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalCause: cause,
      refusalFoundBy: "test",
      refusalError: `ses refused: ${cause}`,
    });
  });

  // Each lets other email through, or clears on its own.
  it.each([
    ["sandbox", "account"],
    ["quota", "account"],
    ["content", "account"],
    ["invalid_request", "account"],
    ["rate_limit", "unavailable"],
    ["outage", "unavailable"],
  ] as const)("a refusal for %s doesn't", async (cause, reason) => {
    await noteContact(
      env.DB,
      config,
      "confirmation",
      contactOutcome(halted(cause, reason)),
      Date.now(),
    );
    expect(await readSending(env.DB)).toBeNull();
  });

  it("only an email the provider takes makes it working again, keeping when it last took one", async () => {
    const at = Date.now();
    await noteContact(env.DB, config, "confirmation", contactOutcome(accepted), at);
    vi.setSystemTime(at + 60_000);
    await noteContact(env.DB, config, "list", contactOutcome(halted("credentials")), Date.now());
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      since: at + 60_000,
      lastAcceptedAt: at,
      lastAcceptedBy: "confirmation",
    });
    vi.setSystemTime(at + 120_000);
    await noteContact(env.DB, config, "test", contactOutcome(accepted), Date.now());
    expect(await readSending(env.DB)).toMatchObject({
      state: "working",
      since: at + 120_000,
      lastAcceptedAt: at + 120_000,
      lastAcceptedBy: "test",
      refusalCause: null,
    });
  });

  it("records nothing while no provider is connected", async () => {
    await noteContact(
      env.DB,
      { ...config, provider: "none" },
      "test",
      contactOutcome(accepted),
      Date.now(),
    );
    expect(await readSending(env.DB)).toBeNull();
  });
});

describe("a send to the list writes it, once a tick (SPEC §9, §12)", () => {
  it("a send the provider takes makes email working", async () => {
    await seedConfirmed(["a@example.com", "b@example.com"]);
    await dueSend();
    await tick();
    expect(await readSending(env.DB)).toMatchObject({ state: "working", lastAcceptedBy: "list" });
  });

  it("a send the provider refuses for the account makes email refusing", async () => {
    const provider = new BatchProvider();
    provider.refuse = "ses 403 UnrecognizedClientException: bad key";
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(["a@example.com"]);
    await dueSend();
    await tick();
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalCause: "credentials",
      refusalFoundBy: "list",
    });
  });
});

describe("the account check finds a refusal without sending (SPEC §8, §9)", () => {
  const broken = withVars({
    SIMULATE_SENDS: "ses:none",
    SIMULATE_ACCOUNT: "production:set_missing",
  });
  const clean = withVars({ SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production" });
  const signups = (e: AppEnv) => readSignups(env.DB, getConfig(e));

  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, json_object('notifications', json_object('to', json_array('me@example.com'))), 1)`,
    ).run();
  });

  it("makes email refusing and pauses signups, telling the publisher once a day", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    expect(await signups(broken)).toBe("open");
    await tick(broken);
    const row = await readSending(env.DB);
    expect(row).toMatchObject({
      state: "refusing",
      refusalCause: "configuration",
      refusalFoundBy: "account_check",
    });
    expect(row?.refusalError).toContain("SES has no configuration set by that name");
    expect(await signups(broken)).toBe("paused");
    await tick(broken);
    expect(fakeNotifications().map((n) => n.subject)).toEqual([
      "Email isn't going out, and signups are paused",
    ]);
  });

  it("lifts a refusal it found on its next clean reading, back to where email stood", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    await tick(broken);
    expect(await signups(broken)).toBe("paused");
    await tick(clean);
    expect(await readSending(env.DB)).toMatchObject({
      state: "working",
      lastAcceptedBy: "test",
      refusalCause: null,
    });
    expect(await signups(clean)).toBe("open");
  });

  it("never makes email working where none has been: a lifted refusal goes back to not proven", async () => {
    await tick(broken);
    expect((await readSending(env.DB))?.state).toBe("refusing");
    await tick(clean);
    expect(await readSending(env.DB)).toMatchObject({ state: "unproven", refusalCause: null });
    expect(await signups(clean)).toBe("not_open");
  });

  it("leaves a refusal an email met to an email: a clean reading doesn't lift it, and a finding doesn't take it over", async () => {
    await noteContact(
      env.DB,
      config,
      "confirmation",
      contactOutcome(halted("credentials")),
      Date.now(),
    );
    await tick(broken);
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalCause: "credentials",
      refusalFoundBy: "confirmation",
    });
    await tick(clean);
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalFoundBy: "confirmation",
    });
    expect(await signups(clean)).toBe("paused");
    await noteContact(env.DB, config, "test", contactOutcome(accepted), Date.now());
    expect(await signups(clean)).toBe("open");
  });
});
