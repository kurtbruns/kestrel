import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SendFeedResponse, type SendView, STUCK_THRESHOLD_MS } from "../shared/sends";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import * as providers from "../src/providers";
import { clearFakeOutbox } from "../src/providers/fake";
import { Budget } from "../src/send/budget";
import { nextChangeAt } from "../src/send/feed";
import { runSend } from "../src/send/loop";
import { SendWindow } from "../src/send/pace";
import { resolveStuckSend } from "../src/send/resolve";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { isWedged } from "../src/send/wedged";
import { adminAuth } from "./support/auth";
import { toNextTick } from "./support/clock";
import { condition, has } from "./support/conditions";
import { ResendLikeProvider } from "./support/resend_like";

// Wedged has one definition (SPEC §12): sending, nothing left to hand off, recipients in
// flight, and the lease released by the run that left them there. The watch, the feed, the
// sweep, and the notifications all read it, a wedged send is not run again until Resolve,
// and a run on a provider that dedupes under its key never leaves a batch it could re-send
// looking wedged.

const AUTH = await adminAuth();
const base = "https://kestrel.test";
const AUDIENCE = ["ada@example.com", "grace@example.com", "linus@example.org"];

class NoKeyProvider extends ResendLikeProvider {
  override readonly idempotentRetry: boolean = false;
  override readonly idempotencyWindowMs: number | undefined = undefined;
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

async function progress(id: string): Promise<SendView> {
  const res = await SELF.fetch(`${base}/sends/${id}`, { headers: AUTH });
  return ((await res.json()) as { send: SendView }).send;
}

async function row(id: string) {
  const r = await sends.getSend(env.DB, id);
  if (!r) {
    throw new Error("send not found");
  }
  return r;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
  clearFakeOutbox();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a wedged send", () => {
  it("is left alone by the sweep: its rev, its phase, and the feed stay still until Resolve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = new NoKeyProvider();
    provider.loseAnswers = 1;
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);

    await sweep(env); // fires; the one batch's answer is lost, so its fate is unknown
    const wedged = await row(send.id);
    expect(isWedged(wedged)).toBe(true);
    const list = (await (await SELF.fetch(`${base}/sends`, { headers: AUTH })).json()) as {
      cursor: string;
    };
    const requests = provider.requests;

    for (let i = 0; i < 3; i++) {
      await toNextTick(env.DB);
      await sweep(env);
      const now = await row(send.id);
      expect(now.rev).toBe(wedged.rev); // never leased and released again
      expect(now.locked_until).toBeNull();
      const p = await progress(send.id);
      expect([p.phase, has(p, "wedged"), condition(p, "wedged")?.count]).toEqual([
        "needs-attention",
        true,
        3,
      ]);
    }
    expect(provider.requests).toBe(requests); // nothing re-sent (I4)
    const feed = (await (
      await SELF.fetch(`${base}/sends/feed?since=${encodeURIComponent(list.cursor)}`, {
        headers: AUTH,
      })
    ).json()) as SendFeedResponse;
    expect(feed.sends).toEqual([]); // nothing changed, so nothing is reported

    await resolveStuckSend(env, send.id, "accepted", "tester");
    expect((await row(send.id)).status).toBe("sent");
  });
});

describe("the one definition", () => {
  it("reads the same in the watch's predicate and in the SQL the feed, sweep, and notifications use", async () => {
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() + 3_600_000);
    const now = Date.now();
    const cases = [];
    for (const status of ["scheduled", "sending", "sent"]) {
      for (const c_pending of [0, 2]) {
        for (const c_in_flight of [0, 3]) {
          for (const locked_until of [null, now - 1000, now + 60_000]) {
            cases.push({ status, c_pending, c_in_flight, locked_until });
          }
        }
      }
    }
    for (const c of cases) {
      await env.DB.prepare(
        "UPDATE sends SET status = ?, c_pending = ?, c_in_flight = ?, locked_until = ? WHERE id = ?",
      )
        .bind(c.status, c.c_pending, c.c_in_flight, c.locked_until, send.id)
        .run();
      const sql = await env.DB.prepare(`SELECT ${sends.WEDGED_SEND} AS w FROM sends WHERE id = ?`)
        .bind(send.id)
        .first<number>("w");
      expect([c, sql === 1]).toEqual([c, isWedged(c)]);
    }
    expect(cases.filter(isWedged)).toHaveLength(1);
  });
});

describe("a run on a provider that dedupes under its key", () => {
  it("puts a cut-off run's batch it did not reach back in the queue under its key, so the send never reads wedged, and the next run re-sends it under that key", async () => {
    const provider = new ResendLikeProvider();
    vi.spyOn(providers, "getProvider").mockReturnValue(provider);
    await seedConfirmed(AUDIENCE);
    const send = await scheduledSend(Date.now() - 1000);
    // A first run fixes the audience and stops at once (its tick is over).
    await runSend(env, send.id, new Budget(10_000), new SendWindow(undefined, -1));
    // A run cut off mid-batch: every recipient handed off under one key, never answered,
    // and its lease left to run out.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE deliveries SET status = 'dispatched', dispatch_key = 'k-cut', keyed_at = ? WHERE send_id = ?",
      ).bind(now, send.id),
      env.DB.prepare(
        "UPDATE sends SET locked_until = ?, lease_token = 'cut-off' WHERE id = ?",
      ).bind(now - 1000, send.id),
    ]);
    await sends.recomputeSendCounters(env.DB, send.id);

    // The next run has no time left this tick to re-send it, and releases the send.
    await runSend(env, send.id, new Budget(10_000), new SendWindow(undefined, -1));
    const after = await row(send.id);
    expect(after.locked_until).toBeNull();
    expect(isWedged(after)).toBe(false);
    expect([after.c_pending, after.c_in_flight]).toEqual([3, 0]);
    const keys = await env.DB.prepare(
      "SELECT DISTINCT status, dispatch_key FROM deliveries WHERE send_id = ?",
    )
      .bind(send.id)
      .all<{ status: string; dispatch_key: string }>();
    expect(keys.results).toEqual([{ status: "pending", dispatch_key: "k-cut" }]);

    // The run after re-sends that exact batch under its key, and the send finishes.
    await runSend(env, send.id);
    expect(provider.mailed.map((m) => m.key)).toEqual(["k-cut", "k-cut", "k-cut"]);
    expect((await row(send.id)).status).toBe("sent");
  });
});

describe("the pace around a wedge and a cut-off run", () => {
  const NOW = 1_800_000_000_000;
  const base = {
    status: "sending" as const,
    fire_at: NOW - 600_000,
    started_at: NOW - 60_000,
    c_pending: 0,
    c_in_flight: 1,
  };

  it("never hurries for a wedged send, even one still carrying a past halt", () => {
    expect(nextChangeAt({ ...base, locked_until: null, halt_retry_at: NOW - 300_000 }, NOW)).toBe(
      NOW - 60_000 + STUCK_THRESHOLD_MS,
    );
  });

  it("waits for the retry of a halted send whose run was cut off, rather than reading it as moving", () => {
    const retry = NOW + 10 * 60_000;
    expect(
      nextChangeAt({ ...base, c_pending: 3, locked_until: NOW - 1_000, halt_retry_at: retry }, NOW),
    ).toBe(retry - 30_000);
    // With no halt, a cut-off run's expired lease is taken up at the next tick.
    expect(nextChangeAt({ ...base, locked_until: NOW - 1_000, halt_retry_at: null }, NOW)).toBe(
      NOW,
    );
  });
});
