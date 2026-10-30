/**
 * Whether email is getting out (SPEC §9): which answers make it refusing and which don't,
 * that only an email the provider takes makes it working, and that every kind of email and
 * the account check write it.
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSING_CAUSES } from "../shared/provider";
import type { HaltCause } from "../shared/sends";
import { readSending } from "../src/db/sending";
import { getConfig } from "../src/env";
import { fakeNotifications } from "../src/notify/fake";
import * as providers from "../src/providers";
import type { SendBatchResult } from "../src/providers/types";
import { contactOutcome, noteContact } from "../src/services/sending";
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
  it("makes email refusing and tells the publisher once a day, and only an email clears it", async () => {
    const e = withVars({ SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production:set_missing" });
    await env.DB.prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, json_object('notifications', json_object('to', json_array('me@example.com'))), 1)`,
    ).run();
    await tick(e);
    const row = await readSending(env.DB);
    expect(row).toMatchObject({
      state: "refusing",
      refusalCause: "configuration",
      refusalFoundBy: "account_check",
    });
    expect(row?.refusalError).toContain("SES has no configuration set by that name");
    await tick(e);
    expect(fakeNotifications().map((n) => n.subject)).toEqual([
      "Email isn't going out, and signups are paused",
    ]);
  });
});
