/**
 * Whether email is getting out (SPEC §13): which answers make it refusing and which don't,
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
import {
  Contacts,
  contactOutcome,
  noteContact,
  noteRefusal,
  readSignups,
  withoutReaders,
} from "../src/services/sending";
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

describe("what makes email refusing (SPEC §13)", () => {
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

describe("a send to the list writes it, once a tick (SPEC §12, §13)", () => {
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

describe("the account check finds a refusal without sending (SPEC §8, §13)", () => {
  const broken = withVars({
    SIMULATE_SENDS: "ses:none",
    SIMULATE_ACCOUNT: "production:set_missing",
  });
  const clean = withVars({ SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production" });
  const signups = (e: AppEnv) => readSignups(env.DB, getConfig(e));

  it("makes email refusing and pauses signups, telling the publisher once a day", async () => {
    await env.DB.prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, json_object('notifications', json_object('to', json_array('me@example.com'))), 1)`,
    ).run();
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
    // One notice for the day. Without Cloudflare's email it goes through SES, which refuses
    // it as it refuses every email, so it can't arrive: the editor says it instead.
    const notices = await env.DB.prepare(
      "SELECT status, error FROM notifications WHERE kind = 'not_sending'",
    ).all<{ status: string; error: string }>();
    expect(notices.results).toHaveLength(1);
    expect(notices.results[0]?.error).toContain("does not exist");
    expect(fakeNotifications()).toEqual([]);
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

describe("an older answer never replaces a newer one (SPEC §13)", () => {
  it("a sweep's refusal from before the fix doesn't undo the test that proved it", async () => {
    const before = Date.now();
    const contacts = new Contacts();
    // The sweep meets the refusal, then the operator's test goes through while it runs.
    contacts.add("list", contactOutcome(halted("configuration")), before);
    await noteContact(env.DB, config, "test", contactOutcome(accepted), before + 1_000);
    await contacts.record(env.DB, config);
    expect(await readSending(env.DB)).toMatchObject({
      state: "working",
      lastAcceptedBy: "test",
      lastAcceptedAt: before + 1_000,
    });
  });

  it("nor does an account reading taken before a test", async () => {
    const before = Date.now();
    await noteContact(env.DB, config, "test", contactOutcome(accepted), before + 1_000);
    await noteRefusal(
      env.DB,
      { cause: "configuration", foundBy: "account_check", error: "no such set" },
      before,
      false,
    );
    expect((await readSending(env.DB))?.state).toBe("working");
  });

  it("a sweep records the latest of its answers, with the time it was given", async () => {
    const at = Date.now();
    const contacts = new Contacts();
    contacts.add("list", contactOutcome(halted("credentials")), at + 2_000);
    contacts.add("notification", contactOutcome(accepted), at + 1_000);
    await contacts.record(env.DB, config);
    expect(await readSending(env.DB)).toMatchObject({ state: "refusing", since: at + 2_000 });
  });
});

describe("a refusal's words never name a reader (SPEC §7, §13)", () => {
  it("keeps only the sender of the identities SES's not-verified refusal lists", async () => {
    const words =
      "ses 400 MessageRejected: Email address is not verified. The following identities failed the check in region US-EAST-1: ada@example.org, newsletter@send.example.com, bo@example.org";
    await noteContact(
      env.DB,
      config,
      "confirmation",
      { kind: "refused", cause: "sender", error: words },
      Date.now(),
    );
    const stored = (await readSending(env.DB))?.refusalError ?? "";
    expect(stored).toBe(
      "ses 400 MessageRejected: Email address is not verified. The following identities failed the check in region US-EAST-1: newsletter@send.example.com",
    );
    expect(stored).not.toMatch(/example\.org/);
  });

  it("takes out an address anywhere in the words, keeping a domain", () => {
    const from = "Newsletter <newsletter@send.example.com>";
    expect(withoutReaders("failed the check: ada@example.org", from)).toBe("failed the check: …");
    expect(withoutReaders("failed the check: send.example.com, Ada@Example.org", from)).toBe(
      "failed the check: send.example.com",
    );
    expect(withoutReaders("Configuration set <kestrel-mail> does not exist.", from)).toBe(
      "Configuration set <kestrel-mail> does not exist.",
    );
  });
});

describe("a finding an email contradicted pauses signups once (SPEC §13)", () => {
  const sender = withVars({
    SIMULATE_SENDS: "ses:none",
    SIMULATE_ACCOUNT: "production:sender_unverified",
  });
  const setMissing = withVars({
    SIMULATE_SENDS: "ses:none",
    SIMULATE_ACCOUNT: "production:set_missing",
  });
  const clean = withVars({ SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production" });
  const signups = () => readSignups(env.DB, getConfig(clean));

  it("leaves signups open when the same finding comes back after SES took an email", async () => {
    await tick(sender);
    expect(await signups()).toBe("paused");
    // SES took an email all the same: the reading is wrong, as with a sender another account
    // authorized.
    await noteContact(env.DB, config, "test", contactOutcome(accepted), Date.now());
    await tick(sender);
    expect(await signups()).toBe("open");
    expect((await readSending(env.DB))?.checkContradicted).toEqual(["sender"]);
  });

  it("pauses them again for a different finding, and for the same one after a clean reading", async () => {
    await tick(sender);
    await noteContact(env.DB, config, "test", contactOutcome(accepted), Date.now());
    await tick(setMissing);
    expect(await readSending(env.DB)).toMatchObject({
      state: "refusing",
      refusalCause: "configuration",
    });
    await noteContact(env.DB, config, "test", contactOutcome(accepted), Date.now());
    await tick(clean);
    expect((await readSending(env.DB))?.checkContradicted).toEqual([]);
    await tick(sender);
    expect(await signups()).toBe("paused");
  });
});
