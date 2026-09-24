import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import tickerSource from "../scripts/sweep-ticker.mjs?raw";
import type { SendProgress } from "../shared/sends";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { type AppEnv, getConfig } from "../src/env";
import worker from "../src/index";
import { clearFakeOutbox } from "../src/providers/fake";
import { RECEIPTS_CRON, resetSimulation } from "../src/providers/simulate";
import { freeze } from "../src/send/schedule";
import { adminAuth } from "./support/auth";

// Locally, simulated receipts arrive on the dev ticker's own clock (SPEC §10), through the
// scheduled handler with a cron value no deployed trigger can carry, and never because a
// page read /progress. These pin that the receipts cron drains and never sweeps, that a
// read settles nothing, and that the ticker sends the value the Worker listens for.

const AUTH = await adminAuth();
const base = "https://kestrel.test";
const HOUR = 60 * 60 * 1000;

/** The simulation on, with no faults, so every due receipt is a delivery. */
const SIM = { SIMULATE_SENDS: "1:none" };
const withVars = (vars: Record<string, string>): AppEnv =>
  ({ ...env, ...vars }) as unknown as AppEnv;

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

/** Run the Worker's scheduled handler once with `cron` as its trigger, under `e`. */
async function scheduled(cron: string, e: AppEnv = env as AppEnv): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), e, ctx);
  await waitOnExecutionContext(ctx);
}

/** A scheduled send whose fire time has passed, to one confirmed reader: the sweep would fire it. */
async function dueSend(): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('sub-r', 'r@example.com', 'confirmed', 'cfm-r', 'uns-r', ?, ?)",
  )
    .bind(now, now)
    .run();
  const { post } = await posts.createPost(env.DB, { subject: "Due", markdown: "# Hi" }, "test");
  return (await freeze(env, getConfig(env), post, now - 1000)).id;
}

/** A sent send with `n` recipients accepted two hours ago, long past every receipt's lag. */
async function settlingSend(sendId: string, n: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES (?, ?, 'sent', ?, ?)",
  )
    .bind(`p-${sendId}`, `slug-${sendId}`, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, scheduled_at, started_at, completed_at) VALUES (?, ?, 'sent', ?, '', '', '', ?, ?, ?, ?)",
  )
    .bind(sendId, `p-${sendId}`, now - 2 * HOUR, n, now - 2 * HOUR, now - 2 * HOUR, now - 2 * HOUR)
    .run();
  for (let i = 0; i < n; i++) {
    const email = `reader${i}@example.com`;
    await env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, provider_id, attempts, updated_at) VALUES (?, ?, 'accepted', ?, 1, ?)",
    )
      .bind(sendId, email, `sim-${sendId}:${email}`, now - 2 * HOUR)
      .run();
  }
  await sends.recomputeSendCounters(env.DB, sendId);
}

const delivered = async (sendId: string) => (await sends.getSend(env.DB, sendId))?.c_delivered;

describe("the receipts cron", () => {
  it("settles the simulated receipts that have come due and never runs the sweep", async () => {
    await settlingSend("s-settling", 3);
    const due = await dueSend();
    await scheduled(RECEIPTS_CRON, withVars(SIM));
    expect(await delivered("s-settling")).toBe(3);
    expect((await sends.getSend(env.DB, due))?.status).toBe("scheduled");
    await scheduled("* * * * *"); // the deployed trigger: the sweep fires it
    expect((await sends.getSend(env.DB, due))?.status).toBe("sent");
  });

  it("is the value the dev ticker sends", () => {
    expect(tickerSource).toContain(`const RECEIPTS_CRON = "${RECEIPTS_CRON}";`);
  });
});

describe("GET /sends/:id/progress with the simulation on", () => {
  it("settles nothing: reading a send never changes it", async () => {
    await settlingSend("s-read", 3);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${base}/sends/s-read/progress`, { headers: AUTH }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      withVars(SIM),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SendProgress;
    expect([body.phase, body.delivery.confirmed]).toEqual(["settling", 0]);
    expect(await delivered("s-read")).toBe(0);
    // The receipts arrive on the ticker's clock instead.
    await scheduled(RECEIPTS_CRON, withVars(SIM));
    expect(await delivered("s-read")).toBe(3);
  });
});
