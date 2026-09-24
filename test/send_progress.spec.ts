import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import type { SendRow } from "../src/db/sends";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../src/lib/time";
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
    env.DB.prepare("DELETE FROM notifications"),
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

    failFakeSendBatch(1); // first send call throws → the unanswered batch is returned
    await runSend(env, send.id);
    let row = await expectCountersMatchAggregate(send.id);
    expect(row.status).toBe("sending");
    expect(row.c_pending).toBe(2); // back in pending, under its key, for the re-send
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

  it("flags a send in flight too long as stuck, the same on its list row as on its progress", async () => {
    await seedConfirmed("s1@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    failFakeSendBatch(1);
    await runSend(env, send.id); // left sending, with the recipient back in the queue
    const read = async () => {
      const list = (await (
        await SELF.fetch(`${base}/sends?status=sending`, { headers: AUTH })
      ).json()) as any;
      const progress = (await (
        await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH })
      ).json()) as any;
      return [list.sends.find((r: any) => r.id === send.id).stuck, progress.attention.stuck];
    };
    expect(await read()).toEqual([false, false]);
    // Started past the stuck threshold (SPEC §12): both surfaces say so.
    await env.DB.prepare("UPDATE sends SET started_at = ? WHERE id = ?")
      .bind(Date.now() - STUCK_THRESHOLD_MS - 60_000, send.id)
      .run();
    expect(await read()).toEqual([true, true]);
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
      audience_resolved_at: Date.now() - 60_000,
      remade_at: null,
      halt_reason: null,
      halt_cause: null,
      halt_error: null,
      halted_at: null,
      halt_retries: 0,
      halt_retry_at: null,
      c_pending: 0,
      c_in_flight: 0,
      c_accepted: 0,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      c_skipped: 0,
      c_unsent: 0,
      rev: 0,
      ...over,
    };
  }
  const phase = (over: Partial<SendRow>, hasRetries = false) =>
    buildSendProgress(mkSend(over), "fake", hasRetries, Date.now()).phase;

  it("scheduled in the review window, due once the fire time passes, missed only past the threshold", () => {
    const now = Date.now();
    const at = (fire_at: number) =>
      buildSendProgress(
        mkSend({ status: "scheduled", fire_at, started_at: null }),
        "fake",
        false,
        now,
      );
    expect(at(now + 60_000).phase).toBe("scheduled");
    expect(at(now).phase).toBe("due"); // the fire time itself: the next tick starts it
    const late = at(now - 60_000); // an ordinary slow tick is never a miss (SPEC §12)
    expect([late.phase, late.attention.missed]).toEqual(["due", false]);
    const missed = at(now - MISSED_THRESHOLD_MS - 1);
    expect([missed.phase, missed.attention.missed]).toEqual(["due", true]);
  });
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
  it("needs-attention, flagged refused with the provider's words, when the account is refused", () => {
    const since = Date.now() - 120_000;
    const prog = buildSendProgress(
      mkSend({
        status: "sending",
        c_pending: 5,
        halt_reason: "account",
        halt_cause: "credentials",
        halt_error: "resend batch 403: API key is not active",
        halted_at: since,
        halt_retries: 2,
        halt_retry_at: since + 20 * 60_000,
      }),
      "resend",
      false,
      Date.now(),
    );
    expect(prog.phase).toBe("needs-attention");
    expect(prog.attention.refused).toBe(true);
    expect(prog.attention.wedged).toBe(false);
    expect(prog.provider.halt).toEqual({
      reason: "account",
      cause: "credentials",
      error: "resend batch 403: API key is not active",
      since,
      retry_at: since + 20 * 60_000,
    });
  });
  it("backing-off, not refused, while the provider is only unavailable", () => {
    const prog = buildSendProgress(
      mkSend({ status: "sending", c_pending: 5, halt_reason: "unavailable", halt_error: "503" }),
      "resend",
      false,
      Date.now(),
    );
    expect(prog.phase).toBe("backing-off");
    expect(prog.attention.refused).toBe(false);
    expect(prog.provider.halt?.reason).toBe("unavailable");
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

/**
 * A D1 handle whose batches wait until `n` of them have been asked for, then run in the
 * order asked: every caller's reads land before any caller's write, the interleaving two
 * webhooks for one message produce when they arrive together.
 */
function batchesMeetAt(db: D1Database, n: number): D1Database {
  let waiting = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let chain = Promise.resolve();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          waiting += 1;
          if (waiting >= n) {
            open();
          }
          await gate;
          const run = chain.then(() => target.batch(statements));
          chain = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("receipts racing for one recipient", () => {
  it("move the counters once, from where the winner left the row", async () => {
    await seedConfirmed("race@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    const providerId = `fake-${send.id}:race@example.com`;

    // An SES Delivery and a Complaint for the same message, both reading the row as
    // accepted before either writes.
    const db = batchesMeetAt(env.DB, 2);
    const at = Date.now();
    await Promise.all([
      sends.markDeliveryEvent(db, { providerId, event: "delivered", at }),
      sends.markDeliveryEvent(db, { providerId, event: "complained", at }),
    ]);

    const row = await expectCountersMatchAggregate(send.id);
    expect(row.c_complained).toBe(1);
    expect(row.c_delivered).toBe(0);
    expect(row.c_accepted).toBe(0);
  });

  it("leave a worse outcome in place when the better one loses the race", async () => {
    await seedConfirmed("race2@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    const providerId = `fake-${send.id}:race2@example.com`;

    const db = batchesMeetAt(env.DB, 2);
    const at = Date.now();
    await Promise.all([
      sends.markDeliveryEvent(db, { providerId, event: "complained", at }),
      sends.markDeliveryEvent(db, { providerId, event: "delivered", at }),
    ]);

    const row = await expectCountersMatchAggregate(send.id);
    expect(row.c_complained).toBe(1);
    expect(row.c_delivered).toBe(0);
    const outcomes = await sends.deliveryOutcomes(env.DB, send.id);
    expect(outcomes.complained).toBe(1);
  });

  it("check the counters against the record when a receipt turns a sent send complete", async () => {
    await seedConfirmed("s1@example.com");
    await seedConfirmed("s2@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    // A cache that has drifted one short, as the race above used to leave it.
    await env.DB.prepare("UPDATE sends SET c_accepted = 1, c_delivered = 1 WHERE id = ?")
      .bind(send.id)
      .run();

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: `fake-${send.id}:s1@example.com` },
    ]);

    // One recipient still awaits a receipt, so the send is settling, not complete.
    const row = await expectCountersMatchAggregate(send.id);
    expect(row.c_accepted).toBe(1);
    expect(buildSendProgress(row, "fake", false, Date.now()).phase).toBe("settling");
  });
});

describe("a cache that drifted before the receipt rule", () => {
  it("is rebuilt when a receipt drives its accepted count below zero, so a send already reading complete settles again", async () => {
    await seedConfirmed("n1@example.com");
    await seedConfirmed("n2@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    // As the old race left it: one recipient moved out of accepted twice, so the send
    // reads complete while both still await a receipt.
    await env.DB.prepare("UPDATE sends SET c_accepted = 0, c_delivered = 2 WHERE id = ?")
      .bind(send.id)
      .run();

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: `fake-${send.id}:n1@example.com` },
    ]);

    const row = await expectCountersMatchAggregate(send.id);
    expect(row.c_accepted).toBe(1);
    expect(buildSendProgress(row, "fake", false, Date.now()).phase).toBe("settling");
  });
});

describe("resolve counts only the rows it moves", () => {
  it("leaves a row a receipt already reached in its event's bucket", async () => {
    await seedConfirmed("r1@example.com");
    await seedConfirmed("r2@example.com");
    await seedConfirmed("r3@example.com");
    const send = await scheduledSend(Date.now() - 1000);
    await runSend(env, send.id);
    // Two recipients left in flight with their fate unknown, one still queued so the send
    // cannot complete (completion rebuilds the counters, which would hide a bad move).
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sends SET status = 'sending', completed_at = NULL, locked_until = NULL, lease_token = NULL WHERE id = ?",
      ).bind(send.id),
      env.DB.prepare(
        "UPDATE deliveries SET status = 'dispatched', provider_id = NULL, event = NULL WHERE send_id = ? AND email IN ('r1@example.com', 'r2@example.com')",
      ).bind(send.id),
      env.DB.prepare(
        "UPDATE deliveries SET status = 'pending', provider_id = NULL, event = NULL WHERE send_id = ? AND email = 'r3@example.com'",
      ).bind(send.id),
    ]);
    await sends.recomputeSendCounters(env.DB, send.id);
    // A receipt carrying only the address lands on one of the in-flight rows.
    await sends.markDeliveryEvent(env.DB, {
      email: "r1@example.com",
      event: "delivered",
      at: Date.now(),
    });
    await expectCountersMatchAggregate(send.id);

    const lease = await sends.acquireLease(env.DB, send.id, Date.now(), 60_000);
    const resolved = await sends.resolveDispatched(
      env.DB,
      send.id,
      lease!,
      "unsent",
      "test",
      Date.now(),
    );

    expect(resolved).toBe(2);
    const row = await expectCountersMatchAggregate(send.id);
    expect(row.c_in_flight).toBe(0);
    expect(row.c_unsent).toBe(1);
    expect(row.c_delivered).toBe(1);
    expect(row.c_pending).toBe(1);
  });
});
