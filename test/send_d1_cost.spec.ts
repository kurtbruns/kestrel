/**
 * What a send costs in D1's rows, per recipient: fixing the audience, handing
 * every batch off, recording the provider's answers, and every recipient's delivery
 * receipt. Workers Free's D1 refuses every query once a day's written rows are spent, so
 * these ceilings say how large a list one day's allowance can send to. A change that raises
 * them changes that, and has to raise them here on purpose.
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import * as providers from "../src/providers";
import { Budget } from "../src/send/budget";
import { runSend } from "../src/send/loop";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { BatchProvider } from "./support/batching";
import { meterD1 } from "./support/d1_guard";
import { addresses, dueSend, resetDatabase, seedConfirmed } from "./support/fixtures";

/** Batches of 50, as SES's SendBulkEmail takes them. */
class FiftyAtATime extends BatchProvider {
  override readonly maxBatch: number = 50;
}

const RECIPIENTS = 1_000;

// Measured at 14.1 rows written and 41.3 read per recipient, from 16.1 and 118 before the
// hand-off updates were driven from the batch and two unread indexes on deliveries dropped.
const MAX_WRITTEN_PER_RECIPIENT = 14.1;
const MAX_READ_PER_RECIPIENT = 42;

let transport: FiftyAtATime;

beforeEach(async () => {
  await resetDatabase();
  transport = new FiftyAtATime();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The receipts are most of the time: a thousand of them through the real ingest, one D1
// round trip each, so the cost measured is the one a deployed send pays. That is under a
// second locally and has taken nearly nine on a shared CI runner, past the default. Real
// work, not waiting, so the test gets the time it needs rather than a smaller list.
describe("a send's cost in D1 rows", { timeout: 30_000 }, () => {
  it("stays within its per-recipient ceilings, receipts included", async () => {
    await seedConfirmed(addresses(RECIPIENTS));
    const send = await dueSend();
    const meter = meterD1(env.DB);
    const metered = { ...env, DB: meter.db } as AppEnv;

    let finished = false;
    for (let run = 0; run < 10 && !finished; run++) {
      finished = (await runSend(metered, send.id, new Budget(1000))).finished;
    }
    expect(finished).toBe(true);
    expect(transport.mailed).toHaveLength(RECIPIENTS);
    const { applied } = await applyDeliveryEvents(
      meter.db,
      transport.mailed.map((_, i) => ({ type: "delivered", providerId: `msg_${i + 1}` })),
    );
    expect(applied).toBe(RECIPIENTS);

    // A ceiling, not an exact count: a change that lowers the cost passes, one that raises it
    // fails until the ceiling, and what it says about Workers Free, is raised on purpose.
    expect(meter.rowsWritten / RECIPIENTS).toBeLessThanOrEqual(MAX_WRITTEN_PER_RECIPIENT);
    expect(meter.rowsRead / RECIPIENTS).toBeLessThanOrEqual(MAX_READ_PER_RECIPIENT);
  });
});
