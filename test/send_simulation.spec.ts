import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { type AppEnv, type Config, ConfigError, getConfig } from "../src/env";
import worker from "../src/index";
import { getProvider } from "../src/providers";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { ResendProvider } from "../src/providers/resend";
import { SesProvider } from "../src/providers/ses";
import {
  drainSimulatedWebhooks,
  resetSimulation,
  SimProvider,
  simulationActive,
} from "../src/providers/simulate";
import type { EmailProvider, RenderedEmail } from "../src/providers/types";
import { UNSUB_SENTINEL } from "../src/render/render";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { adminAuth } from "./support/auth";
import { RESEND_DEPLOY, SES_DEPLOY } from "./support/deploy";

// The local send simulation behind the provider seam (SPEC §10): list sends only, a profile
// per provider with the adapter's own traits, receipts through the REAL ingest
// (applyDeliveryEvents), and the plain fake untouched when it is off.

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

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
  resetSimulation();
});

/** This suite's env with some vars overridden, as a dev server's own `.dev.vars` would set them. */
const withVars = (vars: Record<string, string>): AppEnv =>
  ({ ...env, ...vars }) as unknown as AppEnv;

/** A request to the Worker under `vars`, waiting for its background work. */
async function fetchWith(
  vars: Record<string, string>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${base}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    withVars(vars),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** `n` confirmed subscribers, `reader0@birds.example` up. */
async function seedConfirmed(n: number): Promise<string[]> {
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

/** A post frozen onto a send that is already due, as the sweep finds one at its fire time. */
async function dueSend(e: AppEnv, subject: string): Promise<string> {
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
      expect(simulation(generic)).toEqual({ profile: "generic", faults: "realistic" });
    }
    expect(simulation("resend")).toEqual({ profile: "resend", faults: "realistic" });
    expect(simulation("SES")).toEqual({ profile: "ses", faults: "realistic" });
    expect(simulation("ses:none")).toEqual({ profile: "ses", faults: "none" });
    expect(simulation("1:none")).toEqual({ profile: "generic", faults: "none" });
    expect(simulation("resend:realistic")).toEqual({ profile: "resend", faults: "realistic" });
  });

  it("refuses a value it doesn't know rather than reading it as off", () => {
    for (const value of ["sendgrid", "ses:loud", "ses:none:x", "resend:", ":none"]) {
      expect(() => simulation(value)).toThrow(ConfigError);
    }
    try {
      simulation("sesv2");
    } catch (err) {
      expect((err as ConfigError).variable).toBe("SIMULATE_SENDS");
    }
  });

  it("is never on outside local dev, whatever it says", () => {
    const deployed = { ...SES_DEPLOY, APP_ORIGIN: "https://newsletter.birds.example" };
    expect(simulation("ses", deployed)).toBeNull();
    expect(simulation("nonsense", deployed)).toBeNull();
    expect(simulation("resend", { ...RESEND_DEPLOY })).toBeNull();
    expect(simulation("resend", { ACCESS_TEAM_DOMAIN: "birds.cloudflareaccess.com" })).toBeNull();
    expect(simulation("resend", { APP_ORIGIN: "https://newsletter.birds.example" })).toBeNull();
  });

  it("is reflected read-only in the deployment view, so a dev tool can read it", async () => {
    const on = await readJson(
      await fetchWith({ SIMULATE_SENDS: "ses:none" }, "/api/settings", { headers: AUTH }),
    );
    expect(on.deployment.simulation).toEqual({ profile: "ses", faults: "none" });
    const off = await readJson(await fetchWith({}, "/api/settings", { headers: AUTH }));
    expect(off.deployment.simulation).toBeNull();
  });

  it("swaps the provider only for the simulator, and the plain fake stays when it is off", () => {
    expect(simulationActive(getConfig(env))).toBe(false);
    expect(getProvider(getConfig(env), env)).not.toBeInstanceOf(SimProvider);
    const on = withVars({ SIMULATE_SENDS: "resend" });
    expect(getProvider(getConfig(on), on)).toBeInstanceOf(SimProvider);
  });

  it("drains nothing while it is off", async () => {
    await seedAccepted("s-off", 5, 2 * HOUR);
    expect(await drainSimulatedWebhooks(env, getConfig(env))).toBe(0);
    const row = await sends.getSend(env.DB, "s-off");
    expect(row!.c_delivered + row!.c_bounced + row!.c_complained).toBe(0);
  });
});

describe("a profile per provider, with the real adapter's traits", () => {
  it("takes batch size, idempotency, key memory, and send rate from SesProvider and ResendProvider", () => {
    // An account allowed three messages a second: the SES profile paces to the same rate.
    const sesVars = { ...SES_DEPLOY, SES_MAX_SEND_RATE: "3" };
    const ses: EmailProvider = new SesProvider(getConfig(withVars(sesVars)), withVars(sesVars));
    const resend: EmailProvider = new ResendProvider(
      getConfig(withVars(RESEND_DEPLOY)),
      withVars(RESEND_DEPLOY),
    );
    for (const [profile, real] of [
      ["ses", ses],
      ["resend", resend],
    ] as const) {
      const sim = new SimProvider(
        { profile, faults: "realistic" },
        getConfig(withVars({ SES_MAX_SEND_RATE: "3" })),
      );
      expect(sim.maxBatch).toBe(real.maxBatch);
      expect(sim.idempotentRetry).toBe(real.idempotentRetry);
      expect(sim.idempotencyWindowMs).toBe(real.idempotencyWindowMs);
      expect(sim.maxRequestRate).toBe(real.maxRequestRate);
      expect(sim.name).toBe("fake"); // a fake-family transport: nothing reaches an inbox
    }
    expect(ses.maxRequestRate).toBe(3);
  });
});

describe("list sends only", () => {
  const recipients = (n: number, tag = "r") =>
    Array.from({ length: n }, (_, i) => ({
      email: `${tag}${i}@birds.example`,
      unsubscribeUrl: `https://kestrel.test/unsubscribe?token=${tag}${i}`,
    }));

  it("hands tests, confirmations, and notifications to the outbox at once, never refused", async () => {
    // The generic profile refuses about one recipient in 25 once; none of these may be.
    const sim = new SimProvider({ profile: "generic", faults: "realistic" }, getConfig(env));
    for (const purpose of ["test", "confirmation", "notification"] as const) {
      const batch = recipients(100, purpose);
      const started = Date.now();
      const answer = await sim.sendBatch(rendered, batch, {
        purpose,
        idempotencyKeyPrefix: `${purpose}-1`,
      });
      expect(Date.now() - started).toBeLessThan(500); // not paced like a list batch
      expect(answer.kind).toBe("answered");
      const results = answer.kind === "answered" ? answer.results : [];
      expect(results.every((r) => r.accepted)).toBe(true);
    }
    expect(fakeOutbox()).toHaveLength(300);
  });

  it("puts a test send and a confirmation in the outbox with the simulation on", async () => {
    const vars = { SIMULATE_SENDS: "ses" };
    const created = await readJson(
      await fetchWith(vars, "/posts", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ subject: "Owls", markdown: "# Owls\n\nHoot." }),
      }),
    );
    const test = await fetchWith(vars, `/posts/${created.post.id}/test`, {
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
    const sim = new SimProvider({ profile: "resend", faults: "none" }, getConfig(env));
    const email = { ...rendered, html: `<p>hi</p><a href="${UNSUB_SENTINEL}">Unsubscribe</a>` };
    const batch = recipients(3);
    const opts = { purpose: "list" as const, idempotencyKeyPrefix: "s-1", idempotencyKey: "s-1-k" };
    const first = await sim.sendBatch(email, batch, opts);
    expect(first.kind === "answered" && first.results.every((r) => r.accepted)).toBe(true);
    // Re-sent under its key, as the loop re-sends a batch whose answer was lost: deduped.
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("halts on the daily quota, resumes at its retry, wedges on a lost request, and Resolve completes it", async () => {
    // Workers Paid's budget, so a tick reaches every recipient; the default models Free.
    const vars = { SIMULATE_SENDS: "ses", SUBREQUEST_BUDGET: "10000" };
    const e = withVars(vars);
    const emails = await seedConfirmed(12);
    const sendId = await dueSend(e, "Kestrels");
    const progress = async () =>
      readJson(await fetchWith(vars, `/sends/${sendId}/progress`, { headers: AUTH }));

    // The first tick runs into the quota, answered as the SES adapter answers it: the
    // account refused, nobody unsent, the retry spaced out.
    await sweep(e);
    let row = (await sends.getSend(env.DB, sendId))!;
    expect(row.halt_reason).toBe("account");
    expect(row.halt_cause).toBe("quota");
    expect(row.halt_error).toMatch(/TooManyRequestsException: Daily message quota exceeded/);
    expect(row.c_unsent).toBe(0);
    expect((await progress()).phase).toBe("needs-attention");

    // A minute later the retry isn't due; at its first step (five minutes) it is.
    vi.setSystemTime(Date.now() + 60_000);
    await sweep(e);
    expect((await sends.getSend(env.DB, sendId))!.halt_reason).toBe("account");
    for (let tick = 0; tick < 10; tick++) {
      vi.setSystemTime(Date.now() + 60_000);
      await sweep(e);
      row = (await sends.getSend(env.DB, sendId))!;
      if (row.c_pending === 0) {
        break;
      }
    }
    // Everyone went but one request lost in flight: SES has no key to re-send it under, so
    // the send is wedged, waiting on the publisher.
    expect(row.halt_reason).toBeNull();
    expect(row.c_pending).toBe(0);
    expect(row.c_in_flight).toBe(1);
    const stuck = await progress();
    expect(stuck.phase).toBe("needs-attention");
    expect(stuck.attention.wedged).toBe(true);
    // It did leave: the lost request is in the outbox, as it would be in the reader's inbox.
    expect(new Set(fakeOutbox().map((m) => m.to))).toEqual(new Set(emails));

    const resolved = await fetchWith(vars, `/sends/${sendId}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ resolution: "accepted" }),
    });
    expect(resolved.status).toBe(200);
    row = (await sends.getSend(env.DB, sendId))!;
    expect(row.status).toBe("sent");
    expect(row.c_unsent).toBe(0);
  });

  it("runs clean with no faults: one tick, no halt, every receipt a delivery", async () => {
    const vars = { SIMULATE_SENDS: "ses:none", SUBREQUEST_BUDGET: "10000" };
    const e = withVars(vars);
    await seedConfirmed(12);
    const sendId = await dueSend(e, "Merlins");
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
    simulation: { profile: "generic", faults: "realistic" },
  });

  it("fabricates due delivered/bounced/complained events and suppresses only the hard-bad addresses (I1, SPEC §10)", async () => {
    await seedAccepted("s-drain", 300, 2 * HOUR); // long-past accepts → all lags elapsed (< the drain cap)

    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(300); // every due recipient gets a receipt

    const row = await sends.getSend(env.DB, "s-drain");
    const settled = row!.c_delivered + row!.c_bounced + row!.c_complained;
    expect(settled).toBe(300);
    expect(row!.c_delivered).toBeGreaterThan(0);

    // The suppression invariant: a HARD bounce or ANY complaint suppresses; a SOFT bounce is
    // counted (in c_bounced) but must NOT suppress. So suppressions == hard bounces + complaints,
    // and a soft bounce sits in c_bounced without a matching suppression.
    const { hard, soft } = await bounceBreakdown("s-drain");
    expect(hard + soft).toBe(row!.c_bounced);
    expect(soft).toBeGreaterThan(0); // the guaranteed floor ensures the counted-not-suppressed path
    const sup = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{
      n: number;
    }>();
    expect(sup!.n).toBe(hard + row!.c_complained);

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
    expect(sup!.n).toBe(hard + row!.c_complained);
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
    await seedAccepted("s-fresh", 20, 0); // just accepted → lag not elapsed
    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(0);
    const row = await sends.getSend(env.DB, "s-fresh");
    expect(row!.c_accepted).toBe(20);
  });
});

describe("the generic profile", () => {
  it("paces a batch, accepting the bulk and refusing a few once, retryably", async () => {
    const provider = new SimProvider({ profile: "generic", faults: "realistic" }, getConfig(env));
    expect(provider.maxBatch).toBe(8);
    expect(provider.idempotentRetry).toBe(true);

    const recipients = Array.from({ length: 40 }, (_, i) => ({
      email: `r${i}@example.com`,
      unsubscribeUrl: `https://x/u?token=t${i}`,
    }));
    const started = Date.now();
    const answer = await provider.sendBatch(rendered, recipients, {
      purpose: "list",
      idempotencyKeyPrefix: "sim-batch",
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
