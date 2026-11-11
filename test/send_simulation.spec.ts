import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIMULATED_ACCOUNT_PROBLEMS,
  SIMULATED_ACCOUNTS,
  SIMULATED_REFUSALS,
  type SimulatedAccountView,
  type SimulationView,
} from "../shared/settings";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { drainSimulatedWebhooks } from "../src/dev/simulated_receipts";
import { type AppEnv, type Config, ConfigError, getConfig } from "../src/env";
import { getProvider } from "../src/providers";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import * as sesAdapter from "../src/providers/ses";
import { SimProvider, simulationActive } from "../src/providers/simulate/provider";
import type { EmailProvider, RenderedEmail } from "../src/providers/types";
import { UNSUB_SENTINEL } from "../src/render/render";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { pacedClock } from "./support/clock";
import { has } from "./support/conditions";
import { SES_DEPLOY } from "./support/deploy";
import { resetDatabase, tick } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { resetSimulation } from "./support/simulation";
import { fetchWith, withVars } from "./support/worker_env";

// The local send simulation behind the provider seam (SPEC §10): list sends only, a profile
// per provider with the adapter's own traits, receipts through the REAL ingest
// (applyDeliveryEvents), and the plain fake untouched when it is off.

const HOUR = 60 * 60 * 1000;
const rendered: RenderedEmail = { subject: "Subj", html: "<p>hi</p>", text: "hi" };

/** Bounce rows split by the taxonomy the sim now emits, read from the recorded detail. */
async function bounceBreakdown(sendId: string): Promise<{ hard: number; soft: number }> {
  const hard = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND event = 'bounced' AND event_detail LIKE '%hard%'",
  )
    .bind(sendId)
    .first<{ n: number }>();
  const soft = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND event = 'bounced' AND event_detail LIKE '%soft%'",
  )
    .bind(sendId)
    .first<{ n: number }>();
  return { hard: hard!.n, soft: soft!.n };
}

/** A `sending` send with `n` accepted-but-unconfirmed recipients, accepted `ageMs` ago. */
async function seedAccepted(sendId: string, n: number, ageMs: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES (?, ?, 'sent', ?, ?)",
  )
    .bind(`p-${sendId}`, `slug-${sendId}`, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, scheduled_at, started_at) VALUES (?, ?, 'sending', ?, '', '', '', ?, ?, ?)",
  )
    .bind(sendId, `p-${sendId}`, now, n, now, now)
    .run();
  for (let i = 0; i < n; i++) {
    const email = `sim${i}@example.com`;
    await env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, provider_id, attempts, updated_at) VALUES (?, ?, 'accepted', ?, 1, ?)",
    )
      .bind(sendId, email, `sim-${sendId}:${email}`, now - ageMs)
      .run();
  }
  await sends.recomputeSendCounters(env.DB, sendId);
}

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  resetSimulation();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `n` recipients of a batch, `${tag}0@birds.example` up, each with its own link. */
const recipients = (n: number, tag = "r") =>
  Array.from({ length: n }, (_, i) => ({
    email: `${tag}${i}@birds.example`,
    unsubscribeUrl: `${base}/unsubscribe?token=${tag}${i}`,
  }));

/** `n` confirmed readers, `reader0@birds.example` up, with index-based ids and tokens
 *  (`sub-0`, `uns-0`) that this spec's links name. */
async function seedReaders(n: number): Promise<string[]> {
  const now = Date.now();
  const emails = Array.from({ length: n }, (_, i) => `reader${i}@birds.example`);
  await env.DB.batch(
    emails.map((email, i) =>
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
      ).bind(`sub-${i}`, email, `cfm-${i}`, `uns-${i}`, now, now),
    ),
  );
  return emails;
}

/** A due send frozen under `e`'s config (its own vars), and its id. */
async function dueSendUnder(e: AppEnv, subject: string): Promise<string> {
  const { post } = await posts.createPost(
    e.DB,
    { subject, markdown: `# ${subject}\n\nbody` },
    "test",
  );
  const send = await freeze(e, getConfig(e), post, Date.now() - 1000);
  return send.id;
}

describe("SIMULATE_SENDS", () => {
  const LOCAL = { PROVIDER: "fake", APP_ORIGIN: "http://localhost:8787" };
  const simulation = (value: string | undefined, over: Record<string, string> = {}) =>
    getConfig(
      withVars({ ...LOCAL, ...over, ...(value === undefined ? {} : { SIMULATE_SENDS: value }) }),
    ).simulation;

  it("is off when unset or off, and names a profile and fault level otherwise", () => {
    for (const off of [undefined, "", "0", "off", "false", "no"]) {
      expect(simulation(off)).toBeNull();
    }
    for (const generic of ["1", "on", "true", "yes", "generic"]) {
      expect(simulation(generic)).toEqual({
        profile: "generic",
        faults: "realistic",
        answer: null,
        account: null,
      });
    }
    expect(simulation("SES")).toEqual({
      profile: "ses",
      faults: "realistic",
      answer: null,
      account: null,
    });
    expect(simulation("ses:none")).toEqual({
      profile: "ses",
      faults: "none",
      answer: null,
      account: null,
    });
    expect(simulation("1:none")).toEqual({
      profile: "generic",
      faults: "none",
      answer: null,
      account: null,
    });
    expect(simulation("ses:realistic")).toEqual({
      profile: "ses",
      faults: "realistic",
      answer: null,
      account: null,
    });
  });

  it("reads a refusal of the account every email meets, through SES's answers only (SPEC §10, §13)", () => {
    expect(simulation("ses:refuse=configuration")).toEqual({
      profile: "ses",
      faults: "realistic",
      answer: { kind: "refuse", cause: "configuration" },
      account: null,
    });
    expect(simulation("ses:none:refuse=suspended")).toMatchObject({
      faults: "none",
      answer: { kind: "refuse", cause: "suspended" },
    });
    // A cause that isn't a refusal of the account, or one SES never answers as an error, and
    // a profile without SES's answers, are refused.
    for (const value of ["ses:refuse=sandbox", "ses:refuse=sending_pool", "1:refuse=paused"]) {
      expect(() => simulation(value), value).toThrow(ConfigError);
    }
  });

  it("reads an outage of SES (SPEC §10)", () => {
    expect(simulation("ses:outage")).toEqual({
      profile: "ses",
      faults: "realistic",
      answer: { kind: "outage" },
      account: null,
    });
    expect(simulation("ses:none:outage")).toMatchObject({
      faults: "none",
      answer: { kind: "outage" },
    });
    // An outage is SES's one answer, so an account problem doesn't add a refusal to it.
    expect(
      getConfig(
        withVars({
          ...LOCAL,
          SIMULATE_SENDS: "ses:outage",
          SIMULATE_ACCOUNT: "production:set_missing",
        }),
      ).simulation?.answer,
    ).toEqual({ kind: "outage" });
    // Only SES's own answers can go down, and an outage is no refusal or fault level.
    for (const value of [
      "ses:outage=5",
      "1:outage",
      "ses:outage:none",
      "ses:outage:refuse=paused",
    ]) {
      expect(() => simulation(value), value).toThrow(ConfigError);
    }
  });

  it("reads a refusal of each send's own email, for SES only and last (SPEC §10, §12)", () => {
    expect(simulation("ses:bad_request")).toEqual({
      profile: "ses",
      faults: "realistic",
      answer: { kind: "bad_request" },
      account: null,
    });
    expect(simulation("SES:none:BAD_REQUEST")).toMatchObject({
      faults: "none",
      answer: { kind: "bad_request" },
    });
    expect(simulation("ses:rejected")?.answer).toEqual({ kind: "rejected" });
    // Only SES's own answers can refuse a send, one answer at a time, after the fault level.
    for (const value of [
      "1:bad_request",
      "generic:none:rejected",
      "ses:bad_request:none",
      "ses:rejected:none",
      "ses:bad_request=1",
      "ses:bad-request",
      "ses:refuse=content",
      "ses:content",
      "ses:outage:bad_request",
      "ses:bad_request:rejected",
      "ses:rejected:outage",
      "ses:refuse=paused:bad_request",
    ]) {
      expect(() => simulation(value), value).toThrow(ConfigError);
    }
  });

  it("refuses every email as the account would, for an account problem that stops sending (SPEC §10, §13)", () => {
    const answer = (sends: string, account: string) =>
      getConfig(withVars({ SIMULATE_SENDS: sends, SIMULATE_ACCOUNT: account })).simulation?.answer;
    expect(answer("ses", "production:set_missing")).toEqual({
      kind: "refuse",
      cause: "configuration",
    });
    expect(answer("ses", "sandbox:key_rejected")).toEqual({ kind: "refuse", cause: "credentials" });
    expect(answer("ses", "production:shutdown")).toEqual({ kind: "refuse", cause: "paused" });
    expect(answer("ses", "sandbox:unreported:sending_disabled:unrouted")).toEqual({
      kind: "refuse",
      cause: "paused",
    });
    // AWS reviewing the account leaves it sending, and an answer named outright stands.
    expect(answer("ses", "production:probation")).toBeNull();
    expect(answer("ses:refuse=suspended", "production:set_missing")).toEqual({
      kind: "refuse",
      cause: "suspended",
    });
    expect(answer("ses:rejected", "production:set_missing")).toEqual({ kind: "rejected" });
  });

  // Every value .dev.vars.example, CLAUDE.md, the simulate-send skill, the configuration
  // reference, and the line `kestrel dev` prints name, each read as it always has been.
  it("reads every documented spelling of SIMULATE_SENDS and SIMULATE_ACCOUNT as before (SPEC §10)", () => {
    const read = (sends: string, account = "off") =>
      getConfig(withVars({ ...LOCAL, SIMULATE_SENDS: sends, SIMULATE_ACCOUNT: account }))
        .simulation;
    const SENDS: [string, Omit<SimulationView, "account"> | null][] = [
      ["off", null],
      ["not-connected", null],
      ["1", { profile: "generic", faults: "realistic", answer: null }],
      ["generic", { profile: "generic", faults: "realistic", answer: null }],
      ["generic:none", { profile: "generic", faults: "none", answer: null }],
      ["ses", { profile: "ses", faults: "realistic", answer: null }],
      ["ses:none", { profile: "ses", faults: "none", answer: null }],
      ["ses:outage", { profile: "ses", faults: "realistic", answer: { kind: "outage" } }],
      ["ses:bad_request", { profile: "ses", faults: "realistic", answer: { kind: "bad_request" } }],
      ["ses:rejected", { profile: "ses", faults: "realistic", answer: { kind: "rejected" } }],
      ...SIMULATED_REFUSALS.map((cause): [string, Omit<SimulationView, "account">] => [
        `ses:refuse=${cause}`,
        { profile: "ses", faults: "realistic", answer: { kind: "refuse", cause } },
      ]),
    ];
    for (const [value, view] of SENDS) {
      expect(read(value), value).toEqual(view && { ...view, account: null });
    }
    const ACCOUNTS: [string, SimulatedAccountView][] = [
      ...SIMULATED_ACCOUNTS.map((state): [string, SimulatedAccountView] => [
        state,
        { state, bounces_routed: true, receipts: "reported", problem: null },
      ]),
      [
        "sandbox:unrouted",
        { state: "sandbox", bounces_routed: false, receipts: "reported", problem: null },
      ],
      [
        "production:unreported",
        { state: "production", bounces_routed: true, receipts: "unreported", problem: null },
      ],
      [
        "production:wrong_topic",
        { state: "production", bounces_routed: true, receipts: "wrong_topic", problem: null },
      ],
      ...SIMULATED_ACCOUNT_PROBLEMS.map((problem): [string, SimulatedAccountView] => [
        `production:${problem}`,
        { state: "production", bounces_routed: true, receipts: "reported", problem },
      ]),
    ];
    for (const [value, account] of ACCOUNTS) {
      expect(read("ses", value)?.account, value).toEqual(account);
    }
  });

  it("refuses a value it doesn't know rather than reading it as off", () => {
    for (const value of ["sendgrid", "resend", "ses:loud", "ses:none:x", "ses:", ":none"]) {
      expect(() => simulation(value)).toThrow(ConfigError);
    }
    expect(() => simulation("sesv2")).toThrow(
      expect.objectContaining({ name: "ConfigError", variable: "SIMULATE_SENDS" }),
    );
  });

  it("is never on outside local dev, whatever it says", () => {
    const deployed = { ...SES_DEPLOY, APP_ORIGIN: "https://newsletter.birds.example" };
    expect(simulation("ses", deployed)).toBeNull();
    expect(simulation("ses:outage", deployed)).toBeNull();
    expect(simulation("ses:bad_request", deployed)).toBeNull();
    expect(simulation("ses:rejected", deployed)).toBeNull();
    expect(simulation("nonsense", deployed)).toBeNull();
    expect(simulation("ses", { ...SES_DEPLOY })).toBeNull();
    expect(
      simulation("ses", { ACCESS_TEAM_DOMAIN: "birds.cloudflareaccess.com", ACCESS_AUD: "aud" }),
    ).toBeNull();
    expect(
      simulation("ses", {
        ALLOW_FAKE_PROVIDER: "true",
        APP_ORIGIN: "https://newsletter.birds.example",
      }),
    ).toBeNull();
  });

  it("is reflected read-only in the deployment view, so a dev tool can read it", async () => {
    const on = await readJson(
      await fetchWith({ SIMULATE_SENDS: "ses:none" }, "/api/settings", { headers: AUTH }),
    );
    expect(on.deployment.simulation).toEqual({
      profile: "ses",
      faults: "none",
      answer: null,
      account: null,
    });
    const off = await readJson(await fetchWith({}, "/api/settings", { headers: AUTH }));
    expect(off.deployment.simulation).toBeNull();
  });

  it("swaps the provider only for the simulator, and the plain fake stays when it is off", () => {
    expect(simulationActive(getConfig(env))).toBe(false);
    expect(getProvider(getConfig(env), env, null)).not.toBeInstanceOf(SimProvider);
    const on = withVars({ SIMULATE_SENDS: "ses" });
    expect(getProvider(getConfig(on), on, null)).toBeInstanceOf(SimProvider);
  });

  it("drains nothing while it is off", async () => {
    await seedAccepted("s-off", 5, 2 * HOUR);
    expect(await drainSimulatedWebhooks(env, getConfig(env))).toBe(0);
    const row = await sends.getSend(env.DB, "s-off");
    expect(row!.c_delivered + row!.c_bounced + row!.c_complained).toBe(0);
  });
});

describe("the SES profile, with the real adapter's traits", () => {
  it("takes batch size and send rate from SesProvider", () => {
    // An account allowed three messages a second: the SES profile batches the same three a
    // request, at SES's one request a second.
    const sesVars = { ...SES_DEPLOY, SES_MAX_SEND_RATE: "3" };
    const ses: EmailProvider = new sesAdapter.SesProvider(
      getConfig(withVars(sesVars)),
      withVars(sesVars),
      null,
    );
    const sim = new SimProvider(
      {
        profile: "ses",
        faults: "realistic",
        account: null,
        answer: null,
      },
      getConfig(withVars({ SES_MAX_SEND_RATE: "3" })),
    );
    expect(sim.maxBatch).toBe(ses.maxBatch);
    expect(sim.maxRequestRate).toBe(ses.maxRequestRate);
    expect(sim.name).toBe("fake"); // a fake-family transport: nothing reaches an inbox
    expect(ses.maxBatch).toBe(3);
    expect(ses.maxRequestRate).toBe(1);
  });

  it("builds a profile when a simulation is set up, not ahead of it", () => {
    // The send loop and sweep import the simulation in every environment, production
    // included. An adapter answer the SES profile can't read fails setting up that profile
    // (a dev server simulating SES), where built at load it would fail a deployed Worker's
    // startup.
    vi.spyOn(sesAdapter, "classifySesError").mockReturnValue(null);
    const config = getConfig(env);
    expect(
      () =>
        new SimProvider(
          {
            profile: "generic",
            faults: "realistic",
            account: null,
            answer: null,
          },
          config,
        ),
    ).not.toThrow();
    expect(
      () =>
        new SimProvider(
          {
            profile: "ses",
            faults: "realistic",
            account: null,
            answer: null,
          },
          config,
        ),
    ).toThrow("expected a halting error response to exist");
  });
});

describe("list sends only", () => {
  it("hands tests, confirmations, and notifications to the outbox at once, never refused", async () => {
    // The generic profile refuses about one recipient in 25 once; none of these may be.
    const sim = new SimProvider(
      {
        profile: "generic",
        faults: "realistic",
        account: null,
        answer: null,
      },
      getConfig(env),
    );
    for (const purpose of ["test", "confirmation", "notification"] as const) {
      const batch = recipients(100, purpose);
      const started = Date.now();
      const answer = await sim.sendBatch(rendered, batch, {
        purpose,
        tag: `${purpose}-1`,
      });
      // Not paced like a list batch, which spends about 20 ms a recipient here (two seconds
      // for these hundred; see the generic profile's own spec): the bound leaves a slow
      // runner room while still telling the two apart.
      expect(Date.now() - started).toBeLessThan(1000);
      expect(answer.kind).toBe("answered");
      const results = answer.kind === "answered" ? answer.results : [];
      expect(results.every((r) => r.accepted)).toBe(true);
    }
    expect(fakeOutbox()).toHaveLength(300);
  });

  it("answers every email as SES unavailable while it is down, read by the adapter's classifier (SPEC §10)", async () => {
    const classify = vi.spyOn(sesAdapter, "classifySesError");
    const sim = new SimProvider(
      {
        profile: "ses",
        faults: "none",
        account: null,
        answer: { kind: "outage" },
      },
      getConfig(env),
    );
    // The adapter's own reading of the response, not one the simulation restates.
    expect(classify).toHaveBeenCalledWith(
      408,
      "RequestTimeoutException",
      expect.any(String),
      expect.any(String),
    );
    for (const purpose of ["list", "test", "confirmation", "notification"] as const) {
      const answer = await sim.sendBatch(rendered, recipients(2, purpose), {
        purpose,
        tag: `${purpose}-1`,
      });
      expect(answer.kind, purpose).toBe("halted");
      expect(answer.kind === "halted" ? answer.halt : null, purpose).toEqual({
        reason: "unavailable",
        cause: "outage",
        error: expect.stringMatching(/RequestTimeoutException/),
      });
    }
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("holds a list send as unavailable and backs off on the real spacing while SES is down (SPEC §10, §12)", async () => {
    const vars = { SIMULATE_SENDS: "ses:outage" };
    const e = withVars(vars);
    await seedReaders(3);
    const sendId = await dueSendUnder(e, "Kestrels");
    await sweep(e);
    const row = (await sends.getSend(env.DB, sendId))!;
    expect(row.halt_reason).toBe("unavailable");
    expect(row.halt_cause).toBe("outage");
    expect(row.halt_retries).toBe(1);
    expect(row.halt_retry_at! - row.halted_at!).toBe(60_000); // the first step of the backoff
    expect(row.c_pending).toBe(3);
    expect(row.c_in_flight).toBe(0); // nothing stranded for Resolve
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("puts a test send and a confirmation in the outbox with the simulation on", async () => {
    const vars = { SIMULATE_SENDS: "ses" };
    const created = await readJson(
      await fetchWith(vars, "/api/posts", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ subject: "Owls", markdown: "# Owls\n\nHoot." }),
      }),
    );
    const test = await fetchWith(vars, `/api/posts/${created.post.id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "me@birds.example" }),
    });
    expect((await readJson(test)).sent).toBe(true);
    const joined = await fetchWith(vars, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new.reader@birds.example" }),
    });
    expect(joined.status).toBe(200);
    const outbox = await readJson(await fetchWith(vars, "/api/dev/outbox", { headers: AUTH }));
    expect(outbox.messages.map((m: any) => m.to)).toEqual([
      "me@birds.example",
      "new.reader@birds.example",
    ]);
  });

  it("records a simulated list batch in the outbox with each recipient's own link, once per key", async () => {
    const sim = new SimProvider(
      {
        profile: "generic",
        faults: "none",
        account: null,
        answer: null,
      },
      getConfig(env),
    );
    const email = { ...rendered, html: `<p>hi</p><a href="${UNSUB_SENTINEL}">Unsubscribe</a>` };
    const batch = recipients(3);
    const opts = { purpose: "list" as const, tag: "s-1", batchKey: "s-1-k" };
    const first = await sim.sendBatch(email, batch, opts);
    expect(first.kind === "answered" && first.results.every((r) => r.accepted)).toBe(true);
    // The same batch under the same key is recorded once, as the fake records it.
    const again = await sim.sendBatch(email, batch, opts);
    expect(again).toEqual(first);
    expect(fakeOutbox().map((m) => m.to)).toEqual(batch.map((r) => r.email));
    expect(fakeOutbox()[1]!.html).toContain("token=r1");
  });
});

describe("the SES profile reaches what an SES failure leads to", { timeout: 60_000 }, () => {
  // Only Date is faked, so the halt's backoff can pass in a moment; the simulated requests
  // still take their real (short) time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("halts on the daily quota, resumes at its retry, wedges on a lost request, and Resolve completes it", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    // Workers Paid's budget, so a tick reaches every recipient; the default models Free. More
    // readers than one group, so the requests after each group's first go out together and
    // the resumed send takes more than one tick.
    // The send id and each batch key seed where the guaranteed states fall and SES's rare
    // real-rate rolls (a reader refused for good, a second lost request), so fixed ids make
    // this run the same every time instead of failing on an unlucky roll now and then. If a
    // change to how ids are drawn lands a roll the assertions below don't allow for, change
    // the prefix.
    let ids = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () => `5e5e5e5e-0000-4000-8000-${(++ids).toString(16).padStart(12, "0")}` as const,
    );
    // Read back, not silenced: the log's story is asserted at the end.
    const printed = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    // An account allowed three a second, so the 30 readers go as ten requests of three: enough
    // for the quota and the lost request to fall where the profile places them.
    const vars = { SIMULATE_SENDS: "ses", SUBREQUEST_BUDGET: "10000", SES_MAX_SEND_RATE: "3" };
    const e = withVars(vars);
    const emails = await seedReaders(30);
    const sendId = await dueSendUnder(e, "Kestrels");
    const progress = async () =>
      (await readJson(await fetchWith(vars, `/api/sends/${sendId}`, { headers: AUTH }))).send;
    const addresses = async (status: string) =>
      (
        await env.DB.prepare("SELECT email FROM deliveries WHERE send_id = ? AND status = ?")
          .bind(sendId, status)
          .all<{ email: string }>()
      ).results.map((r) => r.email);
    const sentTo = () => new Set(fakeOutbox().map((m) => m.to));

    // The first tick runs into the quota on one of its first requests, answered as the SES
    // adapter answers it: the account refused, nobody unsent, the retry spaced out. Every
    // request after the refusal is refused too, the ones the loop sent alongside it
    // included, so only what the provider took before it went out and nothing is in flight.
    await sweep(e);
    let row = (await sends.getSend(env.DB, sendId))!;
    expect(row.halt_reason).toBe("account");
    expect(row.halt_cause).toBe("quota");
    expect(row.halt_error).toMatch(/TooManyRequestsException: Daily message quota exceeded/);
    expect(row.c_unsent).toBe(0);
    expect(row.c_in_flight).toBe(0);
    expect(row.c_accepted).toBeGreaterThanOrEqual(2); // the first request, alone (one may be refused)
    expect(row.c_accepted).toBeLessThanOrEqual(9); // the quota runs out by the 4th
    expect(row.c_pending).toBe(30 - row.c_accepted);
    expect(sentTo()).toEqual(new Set(await addresses("accepted")));
    expect(fakeOutbox()).toHaveLength(row.c_accepted);
    expect((await progress()).phase).toBe("needs_attention");
    const haltedAt = Date.now();
    const beforeQuota = row.c_accepted;

    // A minute later the retry isn't due, and nothing more goes out.
    vi.setSystemTime(Date.now() + 60_000);
    await sweep(e);
    row = (await sends.getSend(env.DB, sendId))!;
    expect(row.halt_reason).toBe("account");
    expect(fakeOutbox()).toHaveLength(beforeQuota);

    // At its first step (five minutes) it is, and the quota has lifted: the send resumes,
    // and a few requests in, one is lost in flight, in this run rather than the halted one.
    while (row.halt_cause === "quota" && Date.now() - haltedAt < 10 * 60_000) {
      vi.setSystemTime(Date.now() + 60_000);
      await sweep(e);
      row = (await sends.getSend(env.DB, sendId))!;
    }
    expect(Date.now() - haltedAt).toBe(5 * 60_000);
    // The lost request holds the send for an outage's first step, a minute, rather than
    // strand another batch at once.
    expect([row.halt_reason, row.halt_cause]).toEqual(["unavailable", "outage"]);
    expect(fakeOutbox().length).toBeGreaterThan(beforeQuota);
    // At least one: SES's own rare loss can add another to the one the profile guarantees.
    expect(row.c_in_flight).toBeGreaterThanOrEqual(1);
    // The lost request ended the run, so the rest waits for the next tick.
    expect(row.c_pending).toBeGreaterThan(0);

    for (let tick = 0; tick < 10 && row.c_pending > 0; tick++) {
      vi.setSystemTime(Date.now() + 60_000);
      await sweep(e);
      row = (await sends.getSend(env.DB, sendId))!;
    }
    // Everyone went but the request lost in flight: SES has no key to re-send it under, so
    // the send is wedged, waiting on the publisher.
    expect(row.halt_reason).toBeNull();
    expect(row.c_pending).toBe(0);
    expect(row.c_in_flight).toBeGreaterThanOrEqual(1);
    const stuck = await progress();
    expect(stuck.phase).toBe("needs_attention");
    expect(has(stuck, "wedged")).toBe(true);
    // It did leave: the lost request is in the outbox, as it would be in the reader's inbox.
    // Only a reader SES refused for good (rare, at its real rate) is missing.
    const refused = await addresses("unsent");
    expect(sentTo()).toEqual(new Set(emails.filter((m) => !refused.includes(m))));

    const resolved = await fetchWith(vars, `/api/sends/${sendId}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ resolution: "accepted" }),
    });
    expect(resolved.status).toBe(200);
    row = (await sends.getSend(env.DB, sendId))!;
    expect(row.status).toBe("sent");
    expect(row.c_unsent).toBe(refused.length);

    // The log tells the same story, the injected faults (tagged with the profile) beside
    // what the app did about each (SPEC §12).
    const story = logged(...printed).filter((line) => line.sendId === sendId);
    const order = (event: string) => story.findIndex((line) => line.event === event);
    expect(story.find((l) => l.event === "sim.quota_spent")).toMatchObject({ profile: "ses" });
    expect(story.find((l) => l.event === "sim.request_lost")).toMatchObject({ profile: "ses" });
    expect(story.find((l) => l.event === "send.halted")).toMatchObject({
      level: "warn",
      reason: "account",
      cause: "quota",
    });
    expect(order("sim.quota_spent")).toBeLessThan(order("send.halted"));
    expect(order("send.halted")).toBeLessThan(order("sim.quota_lifted"));
    expect(order("sim.quota_lifted")).toBeLessThan(order("send.resumed"));
    expect(order("sim.request_lost")).toBeLessThan(order("send.ambiguous"));
    expect(story.filter((l) => l.event === "sim.quota_lifted")).toHaveLength(1);
    expect(story.find((l) => l.event === "send.ambiguous")).toMatchObject({
      level: "error",
      cause: "no_answer",
    });
    for (const spy of printed) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toMatch(/reader\d+@/);
      }
    }
  });

  it("runs clean with no faults: one tick, no halt, every receipt a delivery", async () => {
    const vars = { SIMULATE_SENDS: "ses:none", SUBREQUEST_BUDGET: "10000" };
    const e = withVars(vars);
    await seedReaders(12);
    const sendId = await dueSendUnder(e, "Merlins");
    await sweep(e);
    let row = (await sends.getSend(env.DB, sendId))!;
    expect(row.status).toBe("sent");
    expect(row.halt_reason).toBeNull();
    expect(row.c_accepted).toBe(12);
    vi.setSystemTime(Date.now() + 2 * 60_000); // past every receipt's lag
    await sweep(e);
    row = (await sends.getSend(env.DB, sendId))!;
    expect(row.c_delivered).toBe(12);
  });
});

// Each drain here ingests hundreds of synthetic receipts through the real webhook path,
// row by row in D1: about a second locally and five on a shared CI runner, right at the
// default. Real work, not waiting, so the suite gets the time it needs.
describe("drainSimulatedWebhooks (delayed synthetic receipts through the real ingest)", {
  timeout: 30_000,
}, () => {
  const simConfig = (): Config => ({
    ...getConfig(env),
    simulation: {
      profile: "generic",
      faults: "realistic",
      account: null,
      answer: null,
    },
  });

  it("fabricates due delivered/bounced/complained events and suppresses only the hard-bad addresses (SPEC §10)", async () => {
    await seedAccepted("s-drain", 300, 2 * HOUR); // long-past accepts → all lags elapsed (< the drain cap)

    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(300); // every due recipient gets a receipt

    const row = await sends.getSend(env.DB, "s-drain");
    const settled = row!.c_delivered + row!.c_bounced + row!.c_complained;
    expect(settled).toBe(300);
    expect(row!.c_delivered).toBeGreaterThan(0);

    // The suppression invariant: a HARD bounce suppresses; a SOFT bounce is counted (in
    // c_bounced) but must NOT suppress, and a complaint unsubscribes rather than suppresses
    // (SPEC §7). So suppressions == hard bounces, and a soft bounce sits in c_bounced without
    // a matching suppression.
    const { hard, soft } = await bounceBreakdown("s-drain");
    expect(hard + soft).toBe(row!.c_bounced);
    expect(soft).toBeGreaterThan(0); // the guaranteed floor ensures the counted-not-suppressed path
    const sup = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{
      n: number;
    }>();
    expect(sup!.n).toBe(hard);

    // Idempotent: a second drain finds nothing left awaiting a receipt.
    expect(await drainSimulatedWebhooks(env, simConfig())).toBe(0);
  });

  it("guarantees every edge state on a small send, even at the realistic (rounds-to-zero) rates", async () => {
    // At ~0.1% complaint / ~0.8% soft / ~1.5% hard, a 40-address send rolls ~zero of each edge
    // state. The guaranteed floor (small sends only) must still surface all three so a live watch
    // of a small demo send always shows the full taxonomy.
    await seedAccepted("s-floor", 40, 2 * HOUR);
    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(40);

    const row = await sends.getSend(env.DB, "s-floor");
    const { hard, soft } = await bounceBreakdown("s-floor");
    expect(row!.c_complained).toBeGreaterThan(0); // forced when the natural roll produced none
    expect(soft).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(0);
    // Minimal: it fills gaps, it doesn't juice the rate — a 40-address send stays mostly delivered.
    expect(row!.c_delivered).toBeGreaterThan(30);
    // And it still respects the suppression rule: soft bounces don't suppress.
    const sup = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{
      n: number;
    }>();
    expect(sup!.n).toBe(hard);
  });

  it("counts a soft (transient) bounce without suppressing it (SPEC §10)", async () => {
    // Soft bounces land both from the ~0.8% rate and, if none did, the guaranteed floor — either
    // way at least one is present to exercise the counted-not-suppressed branch.
    await seedAccepted("s-soft", 380, 2 * HOUR);
    await drainSimulatedWebhooks(env, simConfig());

    const soft = await env.DB.prepare(
      "SELECT email FROM deliveries WHERE send_id = ? AND event = 'bounced' AND event_detail LIKE '%soft%'",
    )
      .bind("s-soft")
      .all<{ email: string }>();
    expect(soft.results.length).toBeGreaterThan(0); // the counted-not-suppressed branch is exercised

    // None of the soft-bounced addresses were suppressed — that branch is dead for soft bounces.
    for (const { email } of soft.results) {
      const hit = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions WHERE email = ?")
        .bind(email)
        .first<{ n: number }>();
      expect(hit!.n).toBe(0);
    }
  });

  it("settles receipts in realistic order — delivered before complaints (lag by outcome)", async () => {
    // Accepts aged into the BOUNCE window: past the delivered (~≤12s) and bounce (~≤30s)
    // lags, but short of the complaint (~≥45s) lag. So on this drain every delivery and
    // bounce is due, and no complaint is yet — delivered/bounces genuinely precede complaints.
    // Date is faked so that window holds however long seeding 300 rows takes.
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedAccepted("s-order", 300, 35_000);
    await drainSimulatedWebhooks(env, simConfig());

    const mid = await sends.getSend(env.DB, "s-order");
    expect(mid!.c_delivered).toBeGreaterThan(0);
    expect(mid!.c_complained).toBe(0); // complaints lag longest — none have come due
    // The only rows still awaiting a receipt are the future complainers.
    expect(mid!.c_accepted).toBeGreaterThan(0);

    // Advance time past the complaint window for the still-unconfirmed rows, then drain again.
    const past = Date.now() - 120_000;
    await env.DB.prepare(
      "UPDATE deliveries SET updated_at = ? WHERE send_id = ? AND status = 'accepted' AND event IS NULL",
    )
      .bind(past, "s-order")
      .run();
    await sends.recomputeSendCounters(env.DB, "s-order");
    await drainSimulatedWebhooks(env, simConfig());

    const done = await sends.getSend(env.DB, "s-order");
    expect(done!.c_complained).toBeGreaterThan(0); // complaints arrive last, as feedback loops do
    expect(done!.c_accepted).toBe(0); // everyone now has a receipt
  });

  it("leaves not-yet-due recipients unconfirmed (delivery lags acceptance)", async () => {
    // Date is faked so no lag elapses while the rows are seeded, however slow the run.
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedAccepted("s-fresh", 20, 0); // just accepted → lag not elapsed
    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(0);
    const row = await sends.getSend(env.DB, "s-fresh");
    expect(row!.c_accepted).toBe(20);
  });
});

describe("the generic profile", () => {
  it("paces a batch, accepting the bulk and refusing a few once, retryably", async () => {
    const provider = new SimProvider(
      {
        profile: "generic",
        faults: "realistic",
        account: null,
        answer: null,
      },
      getConfig(env),
    );
    expect(provider.maxBatch).toBe(8);

    const started = Date.now();
    const answer = await provider.sendBatch(rendered, recipients(40), {
      purpose: "list",
      tag: "sim-batch",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(800); // a batch takes real time
    expect(answer.kind).toBe("answered");
    const results = answer.kind === "answered" ? answer.results : [];

    expect(results).toHaveLength(40);
    const accepted = results.filter((r) => r.accepted);
    expect(accepted.length).toBeGreaterThan(30); // the bulk succeed
    for (const r of accepted) {
      // The deterministic id is what a delayed receipt later matches on.
      expect((r as { providerId: string }).providerId).toBe(`fake-sim-batch:${r.email}`);
    }
    // A non-accepted result is a well-formed retryable/permanent rejection, never a throw.
    for (const r of results.filter((x) => !x.accepted)) {
      expect(typeof (r as { error: string }).error).toBe("string");
    }
  });
});

describe("a bad request that names no one (SPEC §10, §12)", { timeout: 30_000 }, () => {
  const BAD_REQUEST = {
    profile: "ses",
    faults: "none",
    account: null,
    answer: { kind: "bad_request" },
  } as const;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    pacedClock();
  });

  it("is SES's answer to a list request, read by the adapter's own reading of it", async () => {
    const read = vi.spyOn(sesAdapter, "sesBulkError");
    const sim = new SimProvider(BAD_REQUEST, getConfig(env));
    const two = recipients(2);
    const answer = await sim.sendBatch(rendered, two, { purpose: "list", tag: "s-1" });
    // The adapter's reading of SES's response, not one the simulation restates.
    expect(read).toHaveBeenCalledWith(
      400,
      "BadRequestException",
      expect.any(String),
      expect.any(String),
      two,
    );
    // Two readers and no one named: the request's, so the batch holds.
    expect(answer).toEqual({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "invalid_request",
        error: "ses 400 BadRequestException: Invalid input. (simulated)",
      },
    });
    // One reader: theirs, unless the send loop's group repeats it.
    const [one] = recipients(1);
    expect(await sim.sendBatch(rendered, [one!], { purpose: "list", tag: "s-1" })).toEqual({
      kind: "answered",
      results: [
        {
          email: one!.email,
          accepted: false,
          retryable: false,
          error: "ses 400 BadRequestException: Invalid input. (simulated)",
          ifRepeated: {
            reason: "account",
            cause: "invalid_request",
            error: "ses 400 BadRequestException: Invalid input. (simulated)",
          },
        },
      ],
    });
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("lets a test, a confirmation, and a notification through to the outbox", async () => {
    const sim = new SimProvider(BAD_REQUEST, getConfig(env));
    for (const purpose of ["test", "confirmation", "notification"] as const) {
      const answer = await sim.sendBatch(rendered, recipients(1, purpose), {
        purpose,
        tag: `${purpose}-1`,
      });
      expect(answer.kind === "answered" && answer.results.map((r) => r.accepted), purpose).toEqual([
        true,
      ]);
    }
    expect(fakeOutbox().map((m) => m.to)).toEqual([
      "test0@birds.example",
      "confirmation0@birds.example",
      "notification0@birds.example",
    ]);
  });

  for (const [what, readers, rate] of [
    ["at one email a second, read across the requests sent together", 3, "1"],
    ["for a list of one at one email a second", 1, "1"],
    ["at a production rate, where a request carries every reader", 3, "14"],
  ] as const) {
    it(`holds a list send ${what}, with no one spent and nothing in flight`, async () => {
      const e = withVars({ SIMULATE_SENDS: "ses:bad_request", SES_MAX_SEND_RATE: rate });
      await seedReaders(readers);
      const sendId = await dueSendUnder(e, "Kestrels");
      await sweep(e);
      const row = (await sends.getSend(env.DB, sendId))!;
      expect([row.status, row.halt_reason, row.halt_cause]).toEqual([
        "sending",
        "account",
        "invalid_request",
      ]);
      expect([row.c_pending, row.c_in_flight, row.c_unsent]).toEqual([readers, 0, 0]);
      const { results } = await env.DB.prepare(
        "SELECT attempts FROM deliveries WHERE send_id = ? AND attempts > 0",
      )
        .bind(sendId)
        .all();
      expect(results).toEqual([]);
      expect(fakeOutbox()).toHaveLength(0);
    });
  }

  it("goes out to everyone once after a restart without it", async () => {
    await seedReaders(3);
    const held = withVars({ SIMULATE_SENDS: "ses:bad_request", SES_MAX_SEND_RATE: "1" });
    const sendId = await dueSendUnder(held, "Kestrels");
    await sweep(held);
    expect((await sends.getSend(env.DB, sendId))!.halt_cause).toBe("invalid_request");
    await tick(withVars({ SIMULATE_SENDS: "ses:none", SES_MAX_SEND_RATE: "1" }));
    const row = (await sends.getSend(env.DB, sendId))!;
    expect([row.status, row.c_accepted, row.c_unsent]).toEqual(["sent", 3, 0]);
    expect(
      fakeOutbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual(["reader0@birds.example", "reader1@birds.example", "reader2@birds.example"]);
  });
});

describe("a message SES rejects for its content (SPEC §10, §12)", { timeout: 30_000 }, () => {
  const REJECTED = {
    profile: "ses",
    faults: "none",
    account: null,
    answer: { kind: "rejected" },
  } as const;
  const CONTENT = {
    reason: "account",
    cause: "content",
    error:
      "ses 400 MessageRejected: Message rejected: the message was refused for its content. (simulated)",
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    pacedClock();
  });

  it("is SES's answer to a list request, read by the adapter's own reading of it", async () => {
    const read = vi.spyOn(sesAdapter, "sesBulkError");
    const sim = new SimProvider(REJECTED, getConfig(env));
    const batch = recipients(2);
    const answer = await sim.sendBatch(rendered, batch, { purpose: "list", tag: "s-1" });
    expect(read).toHaveBeenCalledWith(
      400,
      "MessageRejected",
      expect.any(String),
      expect.any(String),
      batch,
    );
    expect(answer).toEqual({ kind: "halted", halt: CONTENT });
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("refuses a test of a post, the send's own email, and lets a confirmation and a notification through", async () => {
    const classify = vi.spyOn(sesAdapter, "classifySesError");
    const sim = new SimProvider(REJECTED, getConfig(env));
    const test = await sim.sendBatch(rendered, recipients(1, "test"), {
      purpose: "test",
      tag: "test-1",
    });
    expect(test).toEqual({ kind: "halted", halt: CONTENT });
    expect(classify).toHaveBeenCalledWith(
      400,
      "MessageRejected",
      expect.any(String),
      expect.any(String),
    );
    for (const purpose of ["confirmation", "notification"] as const) {
      const answer = await sim.sendBatch(rendered, recipients(1, purpose), {
        purpose,
        tag: `${purpose}-1`,
      });
      expect(answer.kind === "answered" && answer.results.map((r) => r.accepted), purpose).toEqual([
        true,
      ]);
    }
    expect(fakeOutbox().map((m) => m.to)).toEqual([
      "confirmation0@birds.example",
      "notification0@birds.example",
    ]);
  });

  it("holds the send on its own, with no one spent, and another send goes out meanwhile", async () => {
    await seedReaders(3);
    const rejecting = withVars({ SIMULATE_SENDS: "ses:rejected" });
    const held = await dueSendUnder(rejecting, "Kestrels");
    await sweep(rejecting);
    const row = (await sends.getSend(env.DB, held))!;
    expect([row.status, row.halt_reason, row.halt_cause]).toEqual([
      "sending",
      "account",
      "content",
    ]);
    expect([row.c_pending, row.c_in_flight, row.c_unsent]).toEqual([3, 0, 0]);

    // SES takes the next post's email: it goes out before the held send's retry, not held by it.
    const taking = withVars({ SIMULATE_SENDS: "ses:none" });
    const next = await dueSendUnder(taking, "Falcons");
    await sweep(taking);
    expect((await sends.getSend(env.DB, next))!.status).toBe("sent");
    const still = (await sends.getSend(env.DB, held))!;
    expect([still.status, still.halt_cause, still.halt_retries]).toEqual(["sending", "content", 1]);
    expect(fakeOutbox()).toHaveLength(3);
  });
});
