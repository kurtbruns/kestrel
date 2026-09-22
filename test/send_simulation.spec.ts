import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { drainSimulatedWebhooks, SimProvider, simulationActive } from "../src/providers/simulate";
import type { RenderedEmail } from "../src/providers/types";

// #156/#163: the dev-only seeded send simulation behind the provider seam. The valuable,
// honest surface to test is the delayed-webhook drain — it runs through the REAL ingest
// (applyDeliveryEvents), so delivery lags acceptance, hard bounces/complaints suppress on
// their own (I1), and soft bounces are counted without suppressing (SPEC §10) — plus that
// the plain fake stays untouched (the simulation is strictly opt-in and dev-shaped).

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
      "INSERT INTO deliveries (id, send_id, email, status, provider_id, attempts, updated_at) VALUES (?, ?, ?, 'accepted', ?, 1, ?)",
    )
      .bind(`d-${sendId}-${i}`, sendId, email, `sim-${sendId}:${email}`, now - ageMs)
      .run();
  }
  await sends.recomputeSendCounters(env.DB, sendId);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
});

describe("simulationActive gating", () => {
  it("is off under the plain dev config and a no-op drain", async () => {
    // The test env has no SIMULATE_SENDS, so getConfig resolves it off.
    expect(simulationActive(getConfig(env))).toBe(false);
    await seedAccepted("s-off", 5, 2 * HOUR);
    const applied = await drainSimulatedWebhooks(env, getConfig(env));
    expect(applied).toBe(0);
    // Nothing was recorded — every row is still awaiting an event.
    const row = await sends.getSend(env.DB, "s-off");
    expect(row!.c_delivered + row!.c_bounced + row!.c_complained).toBe(0);
  });
});

// Each drain here ingests hundreds of synthetic receipts through the real webhook path,
// row by row in D1: about a second locally and five on a shared CI runner, right at the
// default. Real work, not waiting, so the suite gets the time it needs.
describe("drainSimulatedWebhooks (delayed synthetic receipts through the real ingest)", {
  timeout: 30_000,
}, () => {
  const simConfig = () => ({ ...getConfig(env), simulateSends: true });

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

describe("SimProvider.sendBatch", () => {
  it("paces a batch, accepting the bulk with deterministic sim provider ids", async () => {
    const provider = new SimProvider();
    expect(provider.name).toBe("fake"); // a fake-family transport (no real inbox)
    expect(provider.idempotentRetry).toBe(true);

    const recipients = Array.from({ length: 40 }, (_, i) => ({
      email: `r${i}@example.com`,
      unsubscribeUrl: `https://x/u?token=t${i}`,
    }));
    const results = await provider.sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "sim-batch",
    });

    expect(results).toHaveLength(40);
    const accepted = results.filter((r) => r.accepted);
    expect(accepted.length).toBeGreaterThan(30); // the bulk succeed
    for (const r of accepted) {
      // The deterministic id is what a delayed webhook later matches on.
      expect((r as { providerId: string }).providerId).toBe(`sim-sim-batch:${r.email}`);
    }
    // A non-accepted result is a well-formed retryable/permanent rejection, never a throw.
    for (const r of results.filter((x) => !x.accepted)) {
      expect(typeof (r as { error: string }).error).toBe("string");
    }
  });
});
