import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { log, scrub, withRun } from "../src/lib/log";
import * as providers from "../src/providers";
import { clearFakeOutbox } from "../src/providers/fake";
import { cancel, freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { toNextTick } from "./support/clock";
import { ResendLikeProvider } from "./support/resend_like";

// The structured log (SPEC §12): every line one JSON object, a send's lifecycle in order
// under its sendId, and never a recipient's address in any line.

const AUDIENCE = ["ada@example.com", "grace@example.com", "linus@example.org"];

interface Line {
  event: string;
  level: string;
  sendId?: string;
  run?: string;
  [field: string]: unknown;
}

let raw: string[] = [];
let spies: { log: MockInstance; warn: MockInstance; error: MockInstance };

/** Every line the helper logged so far, parsed. The runtime's own notices (a library's
 *  deprecation warning) are not the app's lines; lint keeps the app's to the helper. */
function lines(): Line[] {
  return raw.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text) as Line);
}

const eventsFor = (sendId: string) =>
  lines()
    .filter((l) => l.sendId === sendId)
    .map((l) => l.event);

function expectNoAddress(): void {
  for (const text of raw) {
    for (const address of AUDIENCE) {
      expect(text).not.toContain(address);
      expect(text).not.toContain(`${address.split("@")[0]}@`);
    }
  }
}

async function seedConfirmed(emails: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at)
     SELECT 'id-' || value, value, 'confirmed', 'cfm-' || value, 'uns-' || value, ?, ? FROM json_each(?)`,
  )
    .bind(now, now, JSON.stringify(emails))
    .run();
}

async function scheduledSend(fireAt: number) {
  const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "hi" }, "test");
  return freeze(env, getConfig(env), post, fireAt);
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
  raw = [];
  const capture = (...args: unknown[]) => {
    raw.push(args.map(String).join(" "));
  };
  spies = {
    log: vi.spyOn(console, "log").mockImplementation(capture),
    warn: vi.spyOn(console, "warn").mockImplementation(capture),
    error: vi.spyOn(console, "error").mockImplementation(capture),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the send lifecycle in the log", () => {
  it("a send through the sweep logs fired, batch, completed in order under its sendId, and no address", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await withRun("tick-1", () => sweep(env));

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(eventsFor(send.id)).toEqual(["send.fired", "send.batch", "send.completed"]);
    const all = lines();
    // Every line of the tick carries its run, and the tick closes with its summary.
    expect(all.every((l) => l.run === "tick-1")).toBe(true);
    expect(all.at(-1)).toMatchObject({ event: "sweep.tick", level: "info", due: 1 });
    expect(all.find((l) => l.event === "send.fired")).toMatchObject({
      level: "info",
      postId: send.post_id,
      provider: "fake",
    });
    expect(all.find((l) => l.event === "send.batch")).toMatchObject({
      recipients: 3,
      accepted: 3,
      failed: 0,
    });
    expectNoAddress();
  });

  it("a provider refusal logs send.halted at warn, then send.resumed once a batch is answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new ResendLikeProvider();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    // The provider's words may carry an address; the log keeps only its domain.
    provider.refuse = "The newsletter@send.example.com sender is not verified";
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await sweep(env);
    provider.refuse = null;
    await toNextTick(env.DB);
    await sweep(env);

    expect(eventsFor(send.id)).toEqual([
      "send.fired",
      "send.batch",
      "send.halted",
      "send.batch",
      "send.resumed",
      "send.completed",
    ]);
    const halted = lines().find((l) => l.event === "send.halted")!;
    expect(halted).toMatchObject({ level: "warn", reason: "account", cause: "credentials" });
    expect(halted.error).toBe("The …@send.example.com sender is not verified");
    expect(typeof halted.retryAt).toBe("string");
    expectNoAddress();
  });

  it("receipts and the suppressions they add are logged per send, as counts", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);
    await sweep(env);
    const { results } = await env.DB.prepare(
      "SELECT email, provider_id FROM deliveries WHERE send_id = ? ORDER BY email",
    )
      .bind(send.id)
      .all<{ email: string; provider_id: string }>();
    raw = [];

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: results[0]!.provider_id },
      { type: "bounced", providerId: results[1]!.provider_id, hard: true },
      { type: "complained", email: "nobody@example.net" },
    ]);

    expect(lines()).toEqual([
      expect.objectContaining({
        event: "receipt.applied",
        sendId: send.id,
        delivered: 1,
        bounced: 1,
        recorded: 2,
      }),
      expect.objectContaining({
        event: "suppression.added",
        sendId: send.id,
        source: "webhook",
        bounce: 1,
      }),
      expect.objectContaining({ event: "receipt.applied", matched: false, complained: 1 }),
      expect.objectContaining({ event: "suppression.added", matched: false, complaint: 1 }),
    ]);
    expectNoAddress();
    expect(raw.join("\n")).not.toContain("nobody@");
  });

  it("a cancel is logged against the send", async () => {
    const send = await scheduledSend(Date.now() + 600_000);
    await cancel(env, send.id);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "send.canceled", sendId: send.id, postId: send.post_id }),
    ]);
  });
});

describe("the helper", () => {
  it("writes one JSON object a line, at the console method its level names", () => {
    log.warn("send.halted", { sendId: "s1", reason: "account", retries: 2, skipped: undefined });
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.log).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      { event: "send.halted", level: "warn", sendId: "s1", reason: "account", retries: 2 },
    ]);
  });

  it("keeps an address's domain and drops its local part, anywhere in a string", () => {
    expect(scrub("bounce for Ada.L+news@Example.co.uk (hard)")).toBe(
      "bounce for …@Example.co.uk (hard)",
    );
    expect(scrub("no address here")).toBe("no address here");
  });

  it("never throws, whatever the console does", () => {
    spies.log.mockImplementation(() => {
      throw new Error("console gone");
    });
    expect(() => log.info("sweep.tick")).not.toThrow();
  });
});
