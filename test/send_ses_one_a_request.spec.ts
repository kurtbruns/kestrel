/**
 * A send through Amazon SES at one recipient a request, the rate a new SES account starts at in
 * the sandbox (SPEC §12): the real adapter, the send loop, and the sweep, with SES's answers
 * stubbed. A request carries one reader, so an answer that names no one can't say whether it is
 * about that reader or the request, and none of them is held against the reader: the send
 * holds and says so, and no one is mailed twice (I4).
 */
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { MAX_DELIVERY_ATTEMPTS } from "../src/lib/time";
import * as providers from "../src/providers";
import { SesProvider } from "../src/providers/ses";
import { sweep } from "../src/send/sweep";
import { pacedClock } from "./support/clock";
import { addresses, dueSend, resetDatabase, seedConfirmed, tick } from "./support/fixtures";
import { AUTH, base, JSON_AUTH } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { type BulkRequest, entryOk, readBulkRequest, SES_BULK_ENDPOINT } from "./support/ses";

const sesEnv = {
  ...env,
  AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
} as AppEnv;

/** The real SES adapter at the account's send rate, which is how many recipients a request takes. */
function sesAt(rate: number): void {
  vi.mocked(providers.getProvider).mockImplementation(
    () => new SesProvider({ ...getConfig(sesEnv), sesMaxSendRate: rate }, sesEnv, null),
  );
}

/** An SES error response for a whole request. */
function refusal(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ __type: type, message }), { status });
}

/**
 * SES answering each list request through `fetch`: `answer` gives the request's response, as an
 * error for the whole request or one entry result for each reader. A one-off email (a
 * notification) is taken. Records each request, and how many times each reader was taken.
 */
function ses(answer: (to: string[], n: number) => Response | ((to: string) => object)) {
  const requests: BulkRequest[] = [];
  const mailed = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const req = await readBulkRequest(input);
    if ((input as Request).url !== SES_BULK_ENDPOINT) {
      return new Response(JSON.stringify({ MessageId: crypto.randomUUID() }), { status: 200 });
    }
    requests.push(req);
    const to = req.BulkEmailEntries.map((e) => e.Destination.ToAddresses[0]!);
    const given = answer(to, requests.length);
    if (given instanceof Response) {
      return given;
    }
    const results = to.map((t) => {
      const r = given(t) as { Status: string };
      if (r.Status === "SUCCESS") {
        mailed.set(t, (mailed.get(t) ?? 0) + 1);
      }
      return r;
    });
    return new Response(JSON.stringify({ BulkEmailEntryResults: results }), { status: 200 });
  });
  return { requests, mailed };
}

async function rows(sendId: string) {
  const { results } = await env.DB.prepare(
    "SELECT email, status, attempts FROM deliveries WHERE send_id = ? ORDER BY email",
  )
    .bind(sendId)
    .all<{ email: string; status: string; attempts: number }>();
  return results;
}

/** What the send's page and Claude read about it: its refused condition, if any. */
async function refused(sendId: string) {
  const res = await SELF.fetch(`${base}/api/sends/${sendId}`, { headers: AUTH });
  const { send } = (await res.json()) as {
    send: {
      conditions: { kind: string; cause?: string; recipient?: string | null; message: string }[];
    };
  };
  return send.conditions.find((c) => c.kind === "refused") ?? null;
}

/** Nobody spent: every reader pending with no attempt, the send open, no one unsent. */
async function expectNoOneSpent(sendId: string, audience: number) {
  const all = await rows(sendId);
  expect(all).toHaveLength(audience);
  expect(all.filter((r) => r.status !== "pending" || r.attempts !== 0)).toEqual([]);
  const send = (await sends.getSend(env.DB, sendId))!;
  expect(send.status).toBe("sending");
  expect(send.c_unsent).toBe(0);
  return send;
}

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  pacedClock();
  vi.spyOn(providers, "getProvider");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an answer that names no one, at one recipient a request (SPEC §12)", () => {
  it("a 400 SES can't read, on every request, holds the send naming its one reader, spending no one", async () => {
    sesAt(1);
    const emails = addresses(25);
    await seedConfirmed(emails);
    const send = await dueSend();
    const stub = ses(() => refusal(400, "BadRequestException", "Invalid input"));
    const out = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");

    await tick();

    expect(stub.requests).toHaveLength(1); // the first request alone: the group's others wait
    const [reader] = stub.requests[0]!.BulkEmailEntries[0]!.Destination.ToAddresses;
    const held = await expectNoOneSpent(send.id, 25);
    expect([held.halt_reason, held.halt_cause, held.halt_recipient]).toEqual([
      "account",
      "invalid_request",
      reader,
    ]);
    expect(held.halt_error).toBe("ses 400 BadRequestException: Invalid input");
    const shown = await refused(send.id);
    expect(shown?.recipient).toBe(reader);
    expect(shown?.message).toContain(`block ${reader} under Subscribers`);
    // No line of the log carries the address (SPEC §12).
    expect(JSON.stringify(logged(out, warn))).not.toContain(reader);
    expect(stub.mailed.size).toBe(0);
  });

  it("blocking the reader a hold names lets the send carry on, mailing everyone else once (I4)", async () => {
    sesAt(1);
    const emails = addresses(12);
    await seedConfirmed(emails);
    const send = await dueSend();
    let refusing = true;
    const stub = ses(() =>
      refusing ? refusal(400, "BadRequestException", "Invalid input") : () => entryOk(),
    );
    await tick();
    const reader = (await sends.getSend(env.DB, send.id))!.halt_recipient!;

    const block = await SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email: reader }),
    });
    expect(block.status).toBe(201);
    refusing = false; // the next reader's request goes through: it was the address
    for (let i = 0; i < 5 && (await sends.getSend(env.DB, send.id))!.status !== "sent"; i++) {
      await tick();
    }

    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect([done.halt_reason, done.halt_recipient]).toEqual([null, null]);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 11, skipped: 1 });
    expect(stub.mailed.get(reader)).toBeUndefined();
    expect(emails.filter((e) => e !== reader).every((e) => stub.mailed.get(e) === 1)).toBe(true);
  });

  it("INVALID_PARAMETER naming no one holds the send naming its one reader, spending no one", async () => {
    sesAt(1);
    const emails = addresses(15);
    await seedConfirmed(emails);
    const send = await dueSend();
    const stub = ses(() => () => ({ Status: "INVALID_PARAMETER", Error: "Invalid input" }));

    await tick();

    expect(stub.requests).toHaveLength(1);
    const [reader] = stub.requests[0]!.BulkEmailEntries[0]!.Destination.ToAddresses;
    const held = await expectNoOneSpent(send.id, 15);
    expect([held.halt_cause, held.halt_recipient]).toEqual(["invalid_request", reader]);
    expect(held.halt_error).toBe("ses INVALID_PARAMETER: Invalid input");
  });

  it("a refusal that names its reader is that reader's alone, and the send carries on", async () => {
    sesAt(1);
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    const bad = emails[1]!;
    const stub = ses((to) =>
      to[0] === bad
        ? refusal(400, "BadRequestException", `Illegal address: ${bad}`)
        : () => entryOk(),
    );

    await tick();

    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect((await rows(send.id)).map((r) => [r.email, r.status])).toEqual(
      emails.map((email) => [email, email === bad ? "unsent" : "accepted"]),
    );
    expect(stub.mailed.get(bad)).toBeUndefined();
  });

  it("a list of one, at any rate, holds on an answer that names no one", async () => {
    sesAt(14);
    await seedConfirmed(["solo@example.com"]);
    const send = await dueSend();
    ses(() => refusal(400, "BadRequestException", "Invalid input"));

    await tick();

    const held = await expectNoOneSpent(send.id, 1);
    expect([held.halt_cause, held.halt_recipient]).toEqual(["invalid_request", "solo@example.com"]);
  });

  it("a last request of one, at a higher rate, holds naming its reader and keeps those taken", async () => {
    sesAt(2);
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    const stub = ses((to) =>
      to.length === 1 ? refusal(400, "BadRequestException", "Invalid input") : () => entryOk(),
    );

    await tick();

    const last = stub.requests.find((r) => r.BulkEmailEntries.length === 1)!;
    const [reader] = last.BulkEmailEntries[0]!.Destination.ToAddresses;
    const row = (await sends.getSend(env.DB, send.id))!;
    expect([row.status, row.halt_cause, row.halt_recipient]).toEqual([
      "sending",
      "invalid_request",
      reader,
    ]);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 2, pending: 1 });
    expect((await rows(send.id)).find((r) => r.email === reader)).toEqual({
      email: reader,
      status: "pending",
      attempts: 0,
    });
  });
});

describe("a plain FAILED, judged with its group (SPEC §12)", () => {
  it("answered to two or more requests of a group with no one taken, holds as an outage, spending no one", async () => {
    sesAt(1);
    const emails = addresses(25);
    await seedConfirmed(emails);
    const send = await dueSend();
    const stub = ses(() => () => ({ Status: "FAILED", Error: "Failed" }));

    await tick();

    expect(stub.requests).toHaveLength(10); // one group of ten requests of one
    const held = await expectNoOneSpent(send.id, 25);
    expect([held.halt_reason, held.halt_cause, held.halt_recipient]).toEqual([
      "unavailable",
      "outage",
      null,
    ]);

    // Held across retries, it never spends anyone, however many ticks pass.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
      await tick();
    }
    await expectNoOneSpent(send.id, 25);
    expect(stub.mailed.size).toBe(0);
  });

  it("beside a reader the group took, is its reader's own, retried up to the cap and then unsent", async () => {
    sesAt(1);
    const emails = addresses(3);
    await seedConfirmed(emails);
    const send = await dueSend();
    const failing = emails[0]!;
    const stub = ses((to) =>
      to[0] === failing ? () => ({ Status: "FAILED", Error: "Failed" }) : () => entryOk(),
    );

    await tick();
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBeNull();
    expect((await rows(send.id))[0]).toEqual({ email: failing, status: "pending", attempts: 1 });

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
      await tick();
    }
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect((await rows(send.id))[0]).toEqual({
      email: failing,
      status: "unsent",
      attempts: MAX_DELIVERY_ATTEMPTS,
    });
    expect(emails.slice(1).every((e) => stub.mailed.get(e) === 1)).toBe(true);
  });

  it("in a group of one request, is its reader's own, so a list of one loses at most that one", async () => {
    sesAt(1);
    await seedConfirmed(["solo@example.com"]);
    const send = await dueSend();
    ses(() => () => ({ Status: "FAILED", Error: "Failed" }));

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
      await tick();
    }

    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(await rows(send.id)).toEqual([
      { email: "solo@example.com", status: "unsent", attempts: MAX_DELIVERY_ATTEMPTS },
    ]);
  });
});

describe("an entry status SES doesn't document (SPEC §10, §12)", () => {
  it("stops the run with its one batch in flight for Resolve, the rest waiting with no one spent", async () => {
    allowErrorLogs("send.ambiguous");
    sesAt(1);
    const emails = addresses(25);
    await seedConfirmed(emails);
    const send = await dueSend();
    const stub = ses(() => () => ({ Status: "SOMETHING_NEW", Error: "Unheard of" }));

    await tick();

    expect(stub.requests).toHaveLength(1);
    const [reader] = stub.requests[0]!.BulkEmailEntries[0]!.Destination.ToAddresses;
    const all = await rows(send.id);
    expect(all.filter((r) => r.status === "dispatched").map((r) => r.email)).toEqual([reader]);
    expect(all.filter((r) => r.status === "pending" && r.attempts === 0)).toHaveLength(24);
    const row = (await sends.getSend(env.DB, send.id))!;
    expect([row.status, row.halt_reason, row.c_unsent]).toEqual(["sending", "unavailable", 0]);

    // A sweep inside the backoff leaves it alone: one batch waits for Resolve, not the list.
    vi.setSystemTime(Date.now() + 20_000);
    await sweep(env);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("what one recipient a request leaves as it was (SPEC §12)", () => {
  for (const [what, response, cause] of [
    ["MessageRejected", () => refusal(400, "MessageRejected", "Email rejected"), "content"],
    ["a 404", () => new Response("", { status: 404 }), "configuration"],
    ["a 429", () => refusal(429, "TooManyRequestsException", "Slow down"), "rate_limit"],
    [
      "a 400 naming a configuration set",
      () => refusal(400, "BadRequestException", "Configuration set does not exist"),
      "configuration",
    ],
    [
      "the sandbox's not verified",
      () =>
        refusal(
          400,
          "MessageRejected",
          "Email address is not verified. The following identities failed the check in region US-EAST-1: reader-0@example.com",
        ),
      "sandbox",
    ],
  ] as const) {
    it(`${what} holds the send, naming no one and spending no one`, async () => {
      sesAt(1);
      const emails = addresses(5);
      await seedConfirmed(emails);
      const send = await dueSend();
      const stub = ses(() => response());

      await tick();

      expect(stub.requests).toHaveLength(1);
      const held = await expectNoOneSpent(send.id, 5);
      expect([held.halt_cause, held.halt_recipient]).toEqual([cause, null]);
    });
  }

  it("a 5xx leaves its request's one reader in flight for Resolve and the rest waiting", async () => {
    allowErrorLogs("send.ambiguous");
    sesAt(1);
    const emails = addresses(5);
    await seedConfirmed(emails);
    const send = await dueSend();
    ses(() => refusal(500, "InternalFailure", "Oops"));

    await tick();

    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ dispatched: 1, pending: 4 });
    expect((await sends.getSend(env.DB, send.id))!.halt_reason).toBe("unavailable");
  });

  it("an address SES would refuse for the whole request never goes in one, and is unsent alone", async () => {
    sesAt(1);
    await seedConfirmed(["ok@example.com", "bad addr@example.com"]);
    const send = await dueSend();
    const stub = ses(() => () => entryOk());

    await tick();

    expect(stub.requests.map((r) => r.BulkEmailEntries[0]!.Destination.ToAddresses[0])).toEqual([
      "ok@example.com",
    ]);
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 1, unsent: 1 });
  });
});
