import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sends from "../src/db/sends";
import * as providers from "../src/providers";
import { sweep } from "../src/send/sweep";
import { BatchProvider } from "./support/batching";
import { condition, has } from "./support/conditions";
import { addresses, dueSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { allowErrorLogs } from "./support/log";
import { viewOf } from "./support/view";

// A halt is the account's or the provider's, never one send's (SPEC §12): while one send
// waits out a refusal or an outage, another that comes due joins it and asks the provider
// nothing, so the publisher is told once and no batch is stranded for Resolve. A send's own
// trouble (awaiting Resolve) holds no other.

const MIN = 60_000;
const REFUSAL =
  "ses 403 UnrecognizedClientException: The security token included in the request is invalid";

let transport: BatchProvider;

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = async (id: string) => (await sends.getSend(env.DB, id))!;

async function notified(kind: string) {
  const { results } = await env.DB.prepare(
    "SELECT send_id FROM notifications WHERE kind = ? ORDER BY send_id",
  )
    .bind(kind)
    .all<{ send_id: string }>();
  return results.map((r) => r.send_id);
}

describe("a send that comes due during an account refusal", () => {
  it("asks the provider nothing, reads held with the same retry, is not told twice, and goes out once the refusal lifts (I4)", async () => {
    const emails = addresses(3);
    await seedConfirmed(emails);
    const first = await dueSend({ subject: "First" });
    transport.refuse = REFUSAL;
    await sweep(env);
    const held = await row(first.id);
    expect(held.halt_reason).toBe("account");
    const requests = transport.requests;

    vi.setSystemTime(Date.now() + MIN);
    const second = await dueSend({ subject: "Second" });
    await sweep(env);

    expect(transport.requests).toBe(requests); // the second send asked nothing
    const waiting = await row(second.id);
    expect(waiting).toMatchObject({
      status: "sending",
      halt_reason: "account",
      halt_error: REFUSAL,
      halted_at: held.halted_at,
      halt_retries: held.halt_retries,
      halt_retry_at: held.halt_retry_at,
      audience_resolved_at: null, // fixed when it first hands off, not while held
      c_pending: 0,
      c_in_flight: 0,
    });
    const prog = viewOf(waiting, "ses", false, Date.now());
    expect(prog.phase).toBe("needs-attention");
    expect(condition(prog, "refused")?.retry_at).toBe(held.halt_retry_at);
    expect(has(prog, "stuck")).toBe(false);
    expect(await notified("refused")).toEqual([first.id]);

    // The account is fixed: at the shared retry the first send probes, and both go out.
    transport.refuse = null;
    for (let i = 0; i < 5 && (await row(second.id)).status !== "sent"; i++) {
      vi.setSystemTime(Math.max(Date.now() + MIN, (await row(first.id)).halt_retry_at ?? 0));
      await sweep(env);
    }
    expect([(await row(first.id)).status, (await row(second.id)).status]).toEqual(["sent", "sent"]);
    expect((await row(second.id)).c_accepted).toBe(3);
    expect(emails.every((e) => transport.timesMailed(e) === 2)).toBe(true); // once per post
    expect(await notified("refused")).toEqual([first.id]);
  });
});

describe("a post that fires in the tick a held send retries", () => {
  it("lets the held send ask first, then joins its refusal: one request, one email, the backoff still stepping", async () => {
    await seedConfirmed(addresses(3));
    const first = await dueSend({ subject: "First" });
    transport.refuse = REFUSAL;
    await sweep(env);
    const before = await row(first.id);
    // The post is due exactly when the held send's retry is.
    vi.setSystemTime(before.halt_retry_at!);
    const second = await dueSend({ subject: "Second" });
    const requests = transport.requests;
    await sweep(env);

    expect(transport.requests).toBe(requests + 1); // the held send's retry, and only it
    const retried = await row(first.id);
    expect([retried.halted_at, retried.halt_retries]).toEqual([before.halted_at, 2]);
    const joined = await row(second.id);
    expect([joined.halted_at, joined.halt_retries, joined.halt_retry_at]).toEqual([
      before.halted_at,
      2,
      retried.halt_retry_at,
    ]);
    expect(await notified("refused")).toEqual([first.id]);
  });
});

describe("a send that comes due during an outage the provider went silent in", () => {
  it("strands no batch for Resolve: it joins the outage and reads backing off", async () => {
    allowErrorLogs("send.ambiguous");
    await seedConfirmed(addresses(250));
    const first = await dueSend({ subject: "First" });
    transport.loseAnswers = 1;
    await sweep(env);
    expect((await row(first.id)).halt_reason).toBe("unavailable");
    expect((await row(first.id)).c_in_flight).toBeGreaterThan(0);
    const requests = transport.requests;

    const second = await dueSend({ subject: "Second" });
    vi.setSystemTime(Date.now() + 20_000); // the same minute: the outage's retry is ahead
    await sweep(env);

    expect(transport.requests).toBe(requests);
    const waiting = await row(second.id);
    expect([waiting.halt_reason, waiting.c_in_flight, waiting.halt_retry_at]).toEqual([
      "unavailable",
      0,
      (await row(first.id)).halt_retry_at,
    ]);
    const prog = viewOf(waiting, "ses", false, Date.now());
    expect([prog.phase, prog.dispatch.eta_ms]).toEqual(["backing-off", null]);
  });
});

describe("a send that comes due beside a send awaiting Resolve", () => {
  it("goes out as normal: a wedge is that send's own, not the provider's", async () => {
    allowErrorLogs("send.ambiguous", "send.wedged");
    await seedConfirmed(addresses(3));
    const first = await dueSend({ subject: "First" });
    transport.loseAnswers = 1;
    await sweep(env); // its only batch is lost: wedged, still carrying the outage's halt
    const wedged = await row(first.id);
    expect([wedged.c_pending, wedged.c_in_flight, wedged.locked_until]).toEqual([0, 3, null]);
    expect(wedged.halt_retry_at).toBeGreaterThan(Date.now());

    const second = await dueSend({ subject: "Second" });
    await sweep(env);

    const out = await row(second.id);
    expect([out.status, out.c_accepted, out.halt_reason]).toEqual(["sent", 3, null]);
  });
});
