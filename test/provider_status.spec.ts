import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headingAnchor } from "../shared/docs";
import type { ProviderStatusView } from "../shared/provider";
import * as providerAccount from "../src/db/provider_account";
import { type AccountAnswer, readProviderAccount, recordAnswer } from "../src/db/provider_account";
import { renderDocs } from "../src/docs";
import { getConfig } from "../src/env";
import { ACCOUNT_READ_GAP_MS, identityCandidates } from "../src/providers/ses_account";
import { sweep } from "../src/send/sweep";
import {
  ACCOUNT_CHECK_INTERVAL_MS,
  BOUNCES_DOC,
  PERMISSION_RECHECK_MS,
  providerStatusView,
  sesSendRate,
} from "../src/services/provider_status";
import { NOT_CONNECTED_DEPLOY, SES_DEPLOY } from "./support/deploy";
import { addresses, dueSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH } from "./support/http";
import { logged } from "./support/log";
import { answerSes, SES_BULK_ENDPOINT } from "./support/ses";
import { fetchWith, withVars } from "./support/worker_env";

// The provider's connection (SPEC §9): the sweep asks SES about its account while nothing is
// sending, and GET /api/provider reports where the connection stands from what it last heard.
// What it finds only paces a send (SPEC §12); it never decides whether one goes.

const ACCOUNT = "https://email.us-east-1.amazonaws.com/v2/email/account";
const IDENTITY = "https://email.us-east-1.amazonaws.com/v2/email/identities/";
const SES = withVars(SES_DEPLOY);
const SES_WITH_SET = withVars({ ...SES_DEPLOY, SES_CONFIGURATION_SET: "kestrel-mail" });

/** GetAccount's body for an account in the sandbox, unless `production`. */
function accountBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ProductionAccessEnabled: false,
    SendingEnabled: true,
    EnforcementStatus: "HEALTHY",
    SendQuota: { MaxSendRate: 1, Max24HourSend: 200, SentLast24Hours: 3 },
    Details: { ReviewDetails: { Status: "PENDING", CaseId: "1234567890" } },
    ...over,
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
/** GetEmailIdentity for an identity verified for sending, with its default set, or none. */
const verified = (set: string | null) =>
  ok({
    IdentityType: "DOMAIN",
    VerifiedForSendingStatus: true,
    ...(set ? { ConfigurationSetName: set } : {}),
  });
const sesError = (status: number, type: string, message = "") =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { "x-amzn-ErrorType": `${type}:http://internal.amazon.com/coral/` },
  });

/** Answer SES's read calls by URL, recording each URL asked. */
function answerReads(answer: (url: string) => Response) {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    asked.push(url);
    return answer(url);
  });
  return asked;
}

/** The view GET /api/provider answers under `vars`, from what the check last kept. The route
 *  itself is read over HTTP below, where the suite's sign-in holds (a dev-shaped env). */
async function status(vars: Record<string, string>): Promise<ProviderStatusView> {
  const config = getConfig(withVars(vars));
  return providerStatusView(config, await readProviderAccount(env.DB));
}

const answer = (over: Partial<AccountAnswer> = {}): AccountAnswer => ({
  productionAccess: true,
  review: "granted",
  reviewCase: null,
  maxSendRate: 14,
  max24HourSend: 50_000,
  sentLast24Hours: 0,
  enforcement: "healthy",
  sendingEnabled: true,
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/provider (SPEC §9)", () => {
  it("answers the signed-in editor with the connection, read-only", async () => {
    const res = await fetchWith({}, "/api/provider", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "fake", state: "unknown" });
  });

  it("reads not connected while no provider is named", async () => {
    expect(await status({ ...NOT_CONNECTED_DEPLOY })).toMatchObject({
      provider: "none",
      state: "not_connected",
      send_rate: null,
      warnings: [],
    });
  });

  it("reads unknown for local development's stand-in, which has no account", async () => {
    expect(await status({})).toMatchObject({
      provider: "fake",
      state: "unknown",
      unknown_reason: "stand_in",
    });
  });

  it("reads unknown, not an error, before SES has been asked, and paces by the setting or the default", async () => {
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "unknown",
      unknown_reason: "not_checked",
      send_rate: { value: 14, source: "default" },
      configuration_set: null,
      warnings: [],
      checked_at: null,
    });
    expect((await status({ ...SES_DEPLOY, SES_MAX_SEND_RATE: "3" })).send_rate).toEqual({
      value: 3,
      source: "setting",
    });
  });
});

// SPEC §10: local dev can stand in for the SES account, so the editor can be seen in each state.
describe("SIMULATE_ACCOUNT", () => {
  const simulated = (value: string, over: Record<string, string> = {}) =>
    getConfig(withVars({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: value, ...over })).simulation
      ?.account;
  const read = async (value: string): Promise<ProviderStatusView> =>
    (await fetchWith({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: value }, "/api/provider", {
      headers: AUTH,
    }).then((r) => r.json())) as ProviderStatusView;

  it("is off when unset or off, and names a state, and whether bounces reach the app, otherwise", () => {
    expect(simulated("off")).toBeNull();
    expect(simulated("")).toBeNull();
    expect(simulated("Sandbox")).toEqual({ state: "sandbox", bounces_routed: true });
    expect(simulated("denied:unrouted")).toEqual({ state: "denied", bounces_routed: false });
  });

  it("refuses a value it doesn't know, and an account with no simulated SES beside it", () => {
    for (const value of ["sandboxed", "sandbox:routed", "sandbox:unrouted:x", ":unrouted"]) {
      expect(() => simulated(value)).toThrow(
        expect.objectContaining({ name: "ConfigError", variable: "SIMULATE_ACCOUNT" }),
      );
    }
    for (const sends of ["generic", "off", "not-connected"]) {
      expect(() => simulated("sandbox", { SIMULATE_SENDS: sends })).toThrow(
        expect.objectContaining({ name: "ConfigError", variable: "SIMULATE_ACCOUNT" }),
      );
    }
  });

  it("is never on outside local dev, whatever it says", async () => {
    const deployed = { ...SES_DEPLOY, SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: "production" };
    expect(getConfig(withVars(deployed)).simulation).toBeNull();
    expect(await status(deployed)).toMatchObject({
      state: "unknown",
      unknown_reason: "not_checked",
    });
    expect(
      getConfig(withVars({ ...SES_DEPLOY, SIMULATE_ACCOUNT: "nonsense" })).simulation,
    ).toBeNull();
  });

  it("reads each state as SES would report it", async () => {
    expect(await read("sandbox")).toMatchObject({
      provider: "fake",
      state: "sandbox",
      review: null,
      send_rate: { value: 1, source: "account" },
      account: { max_24_hour_send: 200 },
      warnings: [],
    });
    expect(await read("pending")).toMatchObject({ state: "sandbox", review: "pending" });
    expect(await read("denied")).toMatchObject({
      state: "sandbox",
      review: "denied",
      review_case: "1234567890",
    });
    expect(await read("production")).toMatchObject({
      state: "production",
      send_rate: { value: 14, source: "account" },
      account: { max_24_hour_send: 50_000 },
    });
    expect(await read("permission")).toMatchObject({
      state: "unknown",
      unknown_reason: "permission",
    });
    expect((await read("sandbox:unrouted")).warnings.map((w) => w.code)).toEqual([
      "bounces_not_routed",
    ]);
  });
});

describe("the account check", () => {
  it("reads a sandbox account and its pending review from SES while nothing is sending", async () => {
    const asked = answerReads((url) =>
      url === ACCOUNT ? ok(accountBody()) : verified("kestrel-mail"),
    );
    await sweep(SES);

    expect(asked).toEqual([ACCOUNT, `${IDENTITY}news%40send.birds.example`]);
    const view = await status({ ...SES_DEPLOY });
    expect(view).toEqual({
      provider: "ses",
      state: "sandbox",
      unknown_reason: null,
      review: "pending",
      review_case: "1234567890",
      send_rate: { value: 1, source: "account" },
      account: {
        max_send_rate: 1,
        max_24_hour_send: 200,
        sent_last_24_hours: 3,
        enforcement: "healthy",
        sending_enabled: true,
      },
      configuration_set: { name: "kestrel-mail", source: "identity" },
      warnings: [],
      checked_at: Date.now(),
    } satisfies ProviderStatusView);
  });

  it("reads production once AWS grants it, on the first check after the last one is ten minutes old", async () => {
    let granted = false;
    answerReads((url) =>
      url === ACCOUNT
        ? ok(
            accountBody(
              granted
                ? {
                    ProductionAccessEnabled: true,
                    SendQuota: { MaxSendRate: 14, Max24HourSend: 50000, SentLast24Hours: 0 },
                    Details: { ReviewDetails: { Status: "GRANTED", CaseId: "1234567890" } },
                  }
                : {},
            ),
          )
        : verified("kestrel-mail"),
    );
    await sweep(SES);
    granted = true;
    vi.setSystemTime(Date.now() + ACCOUNT_CHECK_INTERVAL_MS - 1);
    await sweep(SES);
    expect((await status({ ...SES_DEPLOY })).state).toBe("sandbox");

    vi.setSystemTime(Date.now() + 1);
    await sweep(SES);
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "production",
      review: "granted",
      send_rate: { value: 14, source: "account" },
    });
  });

  it("reads a key without ses:GetAccount as unknown, logs nothing above info, and asks again only hourly", async () => {
    const asked = answerReads(() => sesError(403, "AccessDeniedException", "not authorized"));
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await sweep(SES);
    expect(asked).toEqual([ACCOUNT]);
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "unknown",
      unknown_reason: "permission",
      configuration_set: null,
      warnings: [],
    });
    const lines = logged(...spies);
    expect(lines.filter((l) => l.event === "provider.account_checked")).toMatchObject([
      { level: "info", outcome: "permission" },
    ]);
    expect(lines.filter((l) => l.level !== "info")).toEqual([]);

    vi.setSystemTime(Date.now() + ACCOUNT_CHECK_INTERVAL_MS);
    await sweep(SES);
    expect(asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + PERMISSION_RECHECK_MS - ACCOUNT_CHECK_INTERVAL_MS);
    await sweep(SES);
    expect(asked).toHaveLength(2);
  });

  it("keeps the last answer when SES can't be reached", async () => {
    let down = false;
    answerReads((url) =>
      down
        ? sesError(503, "ServiceUnavailable")
        : url === ACCOUNT
          ? ok(accountBody())
          : verified("kestrel-mail"),
    );
    await sweep(SES);
    const before = await status({ ...SES_DEPLOY });
    down = true;
    vi.setSystemTime(Date.now() + ACCOUNT_CHECK_INTERVAL_MS);
    await sweep(SES);
    expect(await status({ ...SES_DEPLOY })).toEqual(before);
  });

  it("doesn't read the identity while SES_CONFIGURATION_SET names the set", async () => {
    const asked = answerReads(() => ok(accountBody()));
    await sweep(SES_WITH_SET);
    expect(asked).toEqual([ACCOUNT]);
    expect(
      (await status({ ...SES_DEPLOY, SES_CONFIGURATION_SET: "kestrel-mail" })).configuration_set,
    ).toEqual({ name: "kestrel-mail", source: "setting" });
  });

  it("reads the identity's set from the most specific identity that exists", async () => {
    const asked = answerReads((url) =>
      url === ACCOUNT
        ? ok(accountBody())
        : url === `${IDENTITY}send.birds.example`
          ? verified("kestrel-mail")
          : sesError(404, "NotFoundException"),
    );
    await sweep(SES);
    expect(asked).toEqual([
      ACCOUNT,
      `${IDENTITY}news%40send.birds.example`,
      `${IDENTITY}send.birds.example`,
    ]);
    expect((await status({ ...SES_DEPLOY })).configuration_set).toEqual({
      name: "kestrel-mail",
      source: "identity",
    });
  });

  it("leaves the set unread, with no warning, when the key may not read the identity", async () => {
    answerReads((url) =>
      url === ACCOUNT ? ok(accountBody()) : sesError(403, "AccessDeniedException"),
    );
    await sweep(SES);
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "sandbox",
      configuration_set: null,
      warnings: [],
    });
  });

  it("asks nothing on a tick that sends, and paces the send by the account's rate (SPEC §12)", async () => {
    await recordAnswer(
      env.DB,
      Date.now() - 2 * ACCOUNT_CHECK_INTERVAL_MS,
      answer({ maxSendRate: 2 }),
    );
    await seedConfirmed(addresses(5));
    await dueSend();
    const { requests, spy } = answerSes();
    await sweep(SES);

    const urls = spy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    );
    expect(urls.every((u) => u === SES_BULK_ENDPOINT)).toBe(true);
    expect(requests.map((r) => r.BulkEmailEntries.length)).toEqual([2, 2, 1]);
  });
});

describe("the bounces warning (SPEC §8, §10)", () => {
  it("warns when no configuration set applies, so bounces and complaints never reach the app", async () => {
    answerReads((url) => (url === ACCOUNT ? ok(accountBody()) : verified(null)));
    await sweep(SES);
    const view = await status({ ...SES_DEPLOY });
    expect(view.configuration_set).toEqual({ name: null, source: "none" });
    expect(view.warnings).toEqual([
      {
        code: "bounces_not_routed",
        severity: "warn",
        message:
          "Bounces and complaints won’t reach Kestrel. Mail from send.birds.example goes out under no configuration set, so a bounced address is mailed again with every post and a complaint unsubscribes no one. Name the set in SES_CONFIGURATION_SET, or make it the sending identity’s default.",
        docs: { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" },
      },
    ]);
  });

  it("points at a heading the guide has", () => {
    const html = renderDocs().docs.find((d) => d.slug === BOUNCES_DOC.slug)?.html ?? "";
    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(([, inner]) =>
      headingAnchor((inner as string).replace(/<[^>]+>/g, "")),
    );
    expect(headings).toContain(BOUNCES_DOC.anchor);
  });
});

describe("the send rate (SPEC §12)", () => {
  it("keeps to the lower of the account's rate and SES_MAX_SEND_RATE, whichever is known, else 14", () => {
    expect(sesSendRate({ sesMaxSendRateSetting: null }, null)).toEqual({
      value: 14,
      source: "default",
    });
    expect(sesSendRate({ sesMaxSendRateSetting: 5 }, null)).toEqual({
      value: 5,
      source: "setting",
    });
    expect(sesSendRate({ sesMaxSendRateSetting: null }, { maxSendRate: 14.5 })).toEqual({
      value: 14,
      source: "account",
    });
    expect(sesSendRate({ sesMaxSendRateSetting: 1 }, { maxSendRate: 14 })).toEqual({
      value: 1,
      source: "setting",
    });
    expect(sesSendRate({ sesMaxSendRateSetting: 50 }, { maxSendRate: 14 })).toEqual({
      value: 14,
      source: "account",
    });
    expect(sesSendRate({ sesMaxSendRateSetting: null }, { maxSendRate: 0.5 })).toEqual({
      value: 1,
      source: "account",
    });
  });
});

describe("identityCandidates", () => {
  it("lists the From address, its domain, and each parent domain down to two labels", () => {
    expect(identityCandidates("Birds <News@send.birds.example>")).toEqual([
      "news@send.birds.example",
      "send.birds.example",
      "birds.example",
    ]);
  });
});

describe("the account check, when SES answers otherwise", () => {
  it("passes over an identity that isn't verified for the verified one beneath it", async () => {
    answerReads((url) =>
      url === ACCOUNT
        ? ok(accountBody())
        : url === `${IDENTITY}news%40send.birds.example`
          ? ok({ IdentityType: "EMAIL_ADDRESS", VerifiedForSendingStatus: false })
          : verified("kestrel-mail"),
    );
    await sweep(SES);
    expect((await status({ ...SES_DEPLOY })).configuration_set).toEqual({
      name: "kestrel-mail",
      source: "identity",
    });
  });

  it("asks SES a second apart, the rate it takes these actions at", async () => {
    const at: number[] = [];
    answerReads((url) => {
      at.push(performance.now());
      return url === ACCOUNT ? ok(accountBody()) : sesError(404, "NotFoundException");
    });
    await sweep(SES);
    expect(at).toHaveLength(4); // the account, then the address and two domains
    for (let i = 1; i < at.length; i++) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(ACCOUNT_READ_GAP_MS - 5);
    }
  });

  it("keeps the identity's set it last read when a later read is throttled, so the warning doesn't flicker", async () => {
    let throttled = false;
    answerReads((url) =>
      url === ACCOUNT
        ? ok(accountBody())
        : throttled
          ? sesError(429, "TooManyRequestsException")
          : verified(null),
    );
    await sweep(SES);
    throttled = true;
    vi.setSystemTime(Date.now() + ACCOUNT_CHECK_INTERVAL_MS);
    await sweep(SES);
    const view = await status({ ...SES_DEPLOY });
    expect(view.configuration_set).toEqual({ name: null, source: "none" });
    expect(view.warnings.map((w) => w.code)).toEqual(["bounces_not_routed"]);
  });

  it("reads AWS's review of the account's sending, and an unlimited daily quota", async () => {
    answerReads((url) =>
      url === ACCOUNT
        ? ok(
            accountBody({
              ProductionAccessEnabled: true,
              EnforcementStatus: "PROBATION",
              SendQuota: { MaxSendRate: 200, Max24HourSend: -1, SentLast24Hours: 12 },
            }),
          )
        : verified("kestrel-mail"),
    );
    await sweep(SES);
    expect((await status({ ...SES_DEPLOY })).account).toEqual({
      max_send_rate: 200,
      max_24_hour_send: null,
      sent_last_24_hours: 12,
      enforcement: "probation",
      sending_enabled: true,
    });
  });

  it("reads an account AWS has paused", async () => {
    answerReads((url) =>
      url === ACCOUNT
        ? ok(accountBody({ EnforcementStatus: "SHUTDOWN", SendingEnabled: false }))
        : verified("kestrel-mail"),
    );
    await sweep(SES);
    expect((await status({ ...SES_DEPLOY })).account).toMatchObject({
      enforcement: "shutdown",
      sending_enabled: false,
    });
  });

  it("reads a throttled first ask as unknown, and asks again in ten minutes", async () => {
    const asked = answerReads(() => sesError(429, "TooManyRequestsException"));
    await sweep(SES);
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "unknown",
      unknown_reason: "unreachable",
    });
    vi.setSystemTime(Date.now() + ACCOUNT_CHECK_INTERVAL_MS);
    await sweep(SES);
    expect(asked).toEqual([ACCOUNT, ACCOUNT]);
  });

  it("reads an answer without its send quota as no answer", async () => {
    answerReads(() => ok({ ProductionAccessEnabled: true }));
    await sweep(SES);
    expect(await status({ ...SES_DEPLOY })).toMatchObject({
      state: "unknown",
      unknown_reason: "unreachable",
      account: null,
    });
  });
});

describe("pacing a send (SPEC §9, §12)", () => {
  it("still sends, at the deployment's rate, when the account's reading can't be read", async () => {
    vi.spyOn(providerAccount, "readProviderAccount").mockRejectedValue(new Error("D1 is down"));
    const warn = vi.spyOn(console, "warn");
    await seedConfirmed(addresses(3));
    await dueSend();
    const { requests } = answerSes();
    await sweep(withVars({ ...SES_DEPLOY, SES_MAX_SEND_RATE: "2" }));

    expect(requests.map((r) => r.BulkEmailEntries.length)).toEqual([2, 1]);
    expect(logged(warn).map((l) => l.event)).toContain("provider.pacing_unread");
  });
});
