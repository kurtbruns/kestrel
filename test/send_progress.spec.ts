import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import type { SendRow } from "../src/db/sends";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { buildSendProgress } from "../src/send/progress";
import { resolveStuckSend } from "../src/send/resolve";
import { freeze } from "../src/send/schedule";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { adminAuth } from "./support/auth";

// PR2 (#154, #152): the denormalized counters on `sends` are a rebuildable cache of the
// `deliveries` bucketing, maintained in the same transactions as each recipient
// transition. These tests pin that they stay consistent across a full send, a resume, a
// webhook, and a resolve — and that /progress + the derived phase read off them.

const config = () => getConfig(env);
const AUTH = await adminAuth();
const base = "https://kestrel.test";

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

async function scheduledSend(fireAt: number) {
  const { post } = await posts.createPost(
    env.DB,
    { subject: "Subj", markdown: "# Hi\n\nbody" },
    "test",
  );
  return freeze(env, config(), post, fireAt);
}

/** The counters must always equal the `deliveries` aggregate (they are its cache). */
async function expectCountersMatchAggregate(sendId: string): Promise<SendRow> {
  const [send, outcomes] = await Promise.all([
    sends.getSend(env.DB, sendId),
    sends.deliveryOutcomes(env.DB, sendId),
  ]);
  if (!send) {
    throw new Error("send not found");
  }
  expect(send.c_delivered).toBe(outcomes.delivered);
  expect(send.c_bounced).toBe(outcomes.bounced);
  expect(send.c_complained).toBe(outcomes.complained);
  expect(send.c_unsent).toBe(outcomes.unsent);
  expect(send.c_skipped).toBe(outcomes.skipped);
  expect(send.c_accepted).toBe(outcomes.accepted);
  // deliveryOutcomes folds pending + dispatched into one `in_flight`; the counters split them.
  expect(send.c_pending + send.c_in_flight).toBe(outcomes.in_flight);
  // Every recipient lands in exactly one bucket, summing to the materialized audience.
  const sum =
    send.c_pending +
    send.c_in_flight +
    send.c_accepted +
    send.c_delivered +
    send.c_bounced +
    send.c_complained +
    send.c_skipped +
    send.c_unsent;
  expect(sum).toBe(outcomes.recipients);
  return send;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
  clearFakeOutbox();
});

describe("send counters (sends.c_*)", () => {
  it("track the deliveries aggregate across a full send", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    await seedConfirmed("c@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    await runSend(env, send.id);

    const row = await expectCountersMatchAggregate(send.id);
    expect(row.status).toBe("sent");
    expect(row.c_accepted).toBe(3);
    expect(row.c_pending).toBe(0);
    expect(row.c_in_flight).toBe(0);
  });

  it("stay consistent through a mid-send crash and resume (I4)", async () => {
    await seedConfirmed("x@example.com");
    await seedConfirmed("y@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    failFakeSendBatch(1); // first send call throws → whole batch requeued
    await runSend(env, send.id);
    let row = await expectCountersMatchAggregate(send.id);
    expect(row.status).toBe("sending");
    expect(row.c_pending).toBe(2); // requeued back to pending
    expect(row.c_in_flight).toBe(0);

    await runSend(env, send.id); // resume
    row = await expectCountersMatchAggregate(send.id);
    expect(row.status).toBe("sent");
    expect(row.c_accepted).toBe(2);
  });

  it("move a recipient from accepted to its event bucket on a webhook (and back out)", async () => {
    await seedConfirmed("d@example.com");
    await seedConfirmed("e@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    expect((await sends.getSend(env.DB, send.id))!.c_accepted).toBe(2);

    // A delivered receipt for one recipient moves it accepted → delivered.
    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: `fake-${send.id}:d@example.com` },
    ]);
    let row = await expectCountersMatchAggregate(send.id);
    expect(row.c_delivered).toBe(1);
    expect(row.c_accepted).toBe(1);

    // A hard bounce for the other suppresses it (I1) and moves accepted → bounced.
    await applyDeliveryEvents(env.DB, [
      { type: "bounced", hard: true, providerId: `fake-${send.id}:e@example.com` },
    ]);
    row = await expectCountersMatchAggregate(send.id);
    expect(row.c_bounced).toBe(1);
    expect(row.c_accepted).toBe(0);
  });

  it("recomputeSendCounters rebuilds the cache from deliveries", async () => {
    await seedConfirmed("f@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    // Corrupt the cache, then rebuild it.
    await env.DB.prepare("UPDATE sends SET c_accepted = 999, c_pending = 42 WHERE id = ?")
      .bind(send.id)
      .run();
    await sends.recomputeSendCounters(env.DB, send.id);
    await expectCountersMatchAggregate(send.id);
  });
});

describe("GET /sends/:id/progress", () => {
  it("reports a single-row progress shape with a derived phase", async () => {
    await seedConfirmed("p1@example.com");
    await seedConfirmed("p2@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);

    const res = await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state).toBe("sent");
    // Everyone accepted, none confirmed yet → still settling.
    expect(body.phase).toBe("settling");
    expect(body.total).toBe(2);
    expect(body.counts.accepted).toBe(2);
    expect(body.dispatch.percent).toBe(100);
    expect(body.delivery.confirmed).toBe(0);
    expect(body.attention.wedged).toBe(false);
    expect(body.provider.name).toBe("fake");
  });

  it("reports the sending state as backing-off after a transient whole-batch failure", async () => {
    await seedConfirmed("q1@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    failFakeSendBatch(1);
    await runSend(env, send.id); // requeues, leaves it sending with pending rows

    const body = (await (
      await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH })
    ).json()) as any;
    expect(body.state).toBe("sending");
    expect(body.phase).toBe("backing-off"); // work remains, nothing in flight
    expect(body.counts.pending).toBe(1);
  });

  it("404s an unknown send and 401s without auth", async () => {
    expect((await SELF.fetch(`${base}/sends/nope/progress`, { headers: AUTH })).status).toBe(404);
    expect((await SELF.fetch(`${base}/sends/nope/progress`)).status).toBe(401);
  });
});

// Phase derivation is pure — exercise every branch off a fabricated row.
describe("buildSendProgress — derived phase", () => {
  function mkSend(over: Partial<SendRow>): SendRow {
    return {
      id: "s",
      post_id: "p",
      status: "sending",
      fire_at: Date.now(),
      rendered_html: "",
      rendered_text: "",
      subject: "s",
      recipient_count: 0,
      locked_until: null,
      scheduled_at: Date.now(),
      started_at: Date.now() - 60_000,
      completed_at: null,
      remade_at: null,
      c_pending: 0,
      c_in_flight: 0,
      c_accepted: 0,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      c_skipped: 0,
      c_unsent: 0,
      ...over,
    };
  }
  const phase = (over: Partial<SendRow>, hasRetries = false) =>
    buildSendProgress(mkSend(over), "fake", hasRetries, Date.now()).phase;

  it("progressing while handing off with no retries", () => {
    expect(phase({ status: "sending", c_pending: 5, c_in_flight: 3 })).toBe("progressing");
  });
  it("retrying while handing off with a retried recipient", () => {
    expect(phase({ status: "sending", c_pending: 5, c_in_flight: 3 }, true)).toBe("retrying");
  });
  it("backing-off when work remains but nothing is in flight", () => {
    expect(phase({ status: "sending", c_pending: 5, c_in_flight: 0 })).toBe("backing-off");
  });
  it("needs-attention (wedged) when nothing is pending but rows are stuck in flight", () => {
    expect(phase({ status: "sending", c_pending: 0, c_in_flight: 2 })).toBe("needs-attention");
  });
  it("progressing (NOT needs-attention) while the loop holds the lease on the final batch", () => {
    // pending 0, in flight > 0, but the loop is actively working it (lease in the future):
    // the tail of a normal dispatch, not a wedge. Without the lease check this flashed
    // "needs attention" at the end of every send.
    expect(
      phase({ status: "sending", c_pending: 0, c_in_flight: 2, locked_until: Date.now() + 60_000 }),
    ).toBe("progressing");
  });
  it("settling once sent while receipts are outstanding, complete when confirmed", () => {
    expect(phase({ status: "sent", c_accepted: 4 })).toBe("settling");
    expect(phase({ status: "sent", c_accepted: 0, c_delivered: 4 })).toBe("complete");
  });
  it("flags a wedged send in attention with its count, but never while the lease is held", () => {
    const wedged = buildSendProgress(
      mkSend({ status: "sending", c_in_flight: 3 }),
      "fake",
      false,
      Date.now(),
    );
    expect(wedged.attention.wedged).toBe(true);
    expect(wedged.attention.wedged_count).toBe(3);
    // Same counts, but the loop holds the lease → actively working, not wedged.
    const working = buildSendProgress(
      mkSend({ status: "sending", c_in_flight: 3, locked_until: Date.now() + 60_000 }),
      "fake",
      false,
      Date.now(),
    );
    expect(working.attention.wedged).toBe(false);
  });
});

describe("resolve keeps counters consistent", () => {
  it("moves the adjudicated in-flight rows into the chosen bucket", async () => {
    await seedConfirmed("w1@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    // Manufacture a wedged row: dispatched, in flight, with the send left sending.
    await runSend(env, send.id);
    await env.DB.prepare("UPDATE sends SET status = 'sending', completed_at = NULL WHERE id = ?")
      .bind(send.id)
      .run();
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'dispatched', event = NULL WHERE send_id = ?",
    )
      .bind(send.id)
      .run();
    await sends.recomputeSendCounters(env.DB, send.id); // baseline the cache to the manufactured state
    expect((await sends.getSend(env.DB, send.id))!.c_in_flight).toBe(1);

    await resolveStuckSend(env, send.id, "unsent", "tester@example.com");
    const row = await expectCountersMatchAggregate(send.id);
    expect(row.status).toBe("sent");
    expect(row.c_unsent).toBe(1);
    expect(row.c_in_flight).toBe(0);
  });
});
