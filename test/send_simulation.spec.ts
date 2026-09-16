import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { drainSimulatedWebhooks, SimProvider, simulationActive } from "../src/providers/simulate";
import type { RenderedEmail } from "../src/providers/types";

// #156: the dev-only seeded send simulation behind the provider seam. The valuable,
// honest surface to test is the delayed-webhook drain — it runs through the REAL ingest
// (applyDeliveryEvents), so delivery lags acceptance and hard bounces/complaints suppress
// on their own (I1) — plus that the plain fake stays untouched (the simulation is
// strictly opt-in and dev-shaped).

const HOUR = 60 * 60 * 1000;
const rendered: RenderedEmail = { subject: "Subj", html: "<p>hi</p>", text: "hi" };

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

describe("drainSimulatedWebhooks (delayed synthetic receipts through the real ingest)", () => {
  const simConfig = () => ({ ...getConfig(env), simulateSends: true });

  it("fabricates due delivered/bounced/complained events and suppresses the bad addresses (I1)", async () => {
    await seedAccepted("s-drain", 300, 2 * HOUR); // long-past accepts → all lags elapsed (< the drain cap)

    const applied = await drainSimulatedWebhooks(env, simConfig());
    expect(applied).toBe(300); // every due recipient gets a receipt

    const row = await sends.getSend(env.DB, "s-drain");
    const settled = row!.c_delivered + row!.c_bounced + row!.c_complained;
    expect(settled).toBe(300);
    expect(row!.c_delivered).toBeGreaterThan(0);
    // At ~2% bounce + ~0.5% complaint over 300, some bad receipts land and suppress.
    const bad = row!.c_bounced + row!.c_complained;
    expect(bad).toBeGreaterThan(0);
    const sup = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{
      n: number;
    }>();
    expect(sup!.n).toBe(bad);

    // Idempotent: a second drain finds nothing left awaiting a receipt.
    expect(await drainSimulatedWebhooks(env, simConfig())).toBe(0);
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
