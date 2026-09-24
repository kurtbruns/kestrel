import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LIVE_IDS_MAX, type LiveSendsResponse, SETTLE_FOLLOW_MS } from "../shared/sends";
import * as posts from "../src/db/posts";
import { getConfig } from "../src/env";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { cancel, freeze, reschedule } from "../src/send/schedule";
import { adminAuth } from "./support/auth";

// GET /sends/live is what the admin pages follow instead of each polling its own endpoint
// (SPEC §8): the sends that can still change on their own, in the /progress shape, and when
// the next one comes due. These pin what it lists, what it leaves out, and that a send reads
// the same there as on its watch.

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

/** A fresh post frozen into a send firing at `fireAt` (each send its own post: one active send a post). */
async function scheduledSend(subject: string, fireAt: number) {
  const { post } = await posts.createPost(env.DB, { subject, markdown: "# Hi\n\nbody" }, "test");
  return freeze(env, config(), post, fireAt);
}

/** Put a send's row in the given state, the way the send loop would have left it. */
async function setRow(id: string, fields: Record<string, number | string | null>): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c] ?? null), id)
    .run();
}

async function live(ids: string[] = []): Promise<LiveSendsResponse> {
  const q = ids.length ? `?ids=${ids.join(",")}` : "";
  const res = await SELF.fetch(`${base}/sends/live${q}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as LiveSendsResponse;
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

describe("GET /sends/live", () => {
  it("lists the due, sending, and settling sends, soonest fire first, and when the next one comes due", async () => {
    const now = Date.now();
    const ahead = await scheduledSend("Ahead", now + 3_600_000);
    const later = await scheduledSend("Later", now + 7_200_000);
    const due = await scheduledSend("Due", now - 10_000);
    const sending = await scheduledSend("Sending", now - 120_000);
    await setRow(sending.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_pending: 5,
      c_accepted: 3,
    });
    const settling = await scheduledSend("Settling", now - 300_000);
    await setRow(settling.id, {
      status: "sent",
      started_at: now - 290_000,
      completed_at: now - 240_000,
      c_accepted: 2,
      c_delivered: 6,
    });
    const complete = await scheduledSend("Complete", now - 600_000);
    await setRow(complete.id, { status: "sent", completed_at: now - 500_000, c_delivered: 8 });
    // Still awaiting receipts, but done with longer ago than a page follows (SPEC §6: some
    // are never confirmed at all).
    const stale = await scheduledSend("Stale", now - SETTLE_FOLLOW_MS - 600_000);
    await setRow(stale.id, {
      status: "sent",
      completed_at: now - SETTLE_FOLLOW_MS - 1,
      c_accepted: 4,
    });
    const canceled = await scheduledSend("Canceled", now + 900_000);
    await cancel(env, canceled.id);

    const body = await live();
    expect(body.sends.map((s) => s.subject)).toEqual(["Settling", "Sending", "Due"]);
    expect(body.named).toEqual([]);
    expect(body.next_fire_at).toBe(ahead.fire_at); // the soonest of Ahead and Later
    expect(later.fire_at).toBeGreaterThan(ahead.fire_at);
    expect(Math.abs(body.now - now)).toBeLessThan(10_000);

    const [s, g, d] = body.sends;
    expect([d?.state, d?.phase, d?.attention.missed]).toEqual(["scheduled", "due", false]);
    expect(d).toMatchObject({ id: due.id, post_id: due.post_id, fire_at: due.fire_at });
    expect([g?.state, g?.phase, g?.counts.pending, g?.counts.accepted]).toEqual([
      "sending",
      "backing-off", // work remains, nothing in flight
      5,
      3,
    ]);
    expect(g?.started_at).toBe(now - 110_000);
    expect([s?.state, s?.phase, s?.completed_at]).toEqual(["sent", "settling", now - 240_000]);
    expect(s?.delivery.confirmed).toBe(6);
  });

  it("reads a send the same as its /progress does", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    const send = await scheduledSend("Live", Date.now() - 1000);
    failFakeSendBatch(1);
    await runSend(env, send.id); // left sending, the batch back in the queue
    const [row] = (await live()).sends;
    const progress = await (
      await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH })
    ).json();
    const { id, post_id, subject, fire_at, started_at, completed_at, ...shape } = row!;
    expect(shape).toEqual(progress);
    expect(id).toBe(send.id);
  });

  it("reports a named send wherever it went once it stops changing on its own", async () => {
    const now = Date.now();
    const done = await scheduledSend("Done", now - 600_000);
    await setRow(done.id, { status: "sent", completed_at: now - 60_000, c_delivered: 3 });
    const dropped = await scheduledSend("Dropped", now + 600_000);
    await cancel(env, dropped.id);
    const moved = await scheduledSend("Moved", now + 600_000);
    await reschedule(env, moved.id, now + 3_600_000);
    const due = await scheduledSend("Due", now - 5_000);

    const body = await live([done.id, dropped.id, moved.id, due.id, "no-such-send"]);
    // A named send that is live is reported once, where it belongs.
    expect(body.sends.map((s) => s.id)).toEqual([due.id]);
    const named = new Map(body.named.map((s) => [s.id, [s.state, s.phase]]));
    expect(Object.fromEntries(named)).toEqual({
      [done.id]: ["sent", "complete"],
      [dropped.id]: ["canceled", "canceled"],
      [moved.id]: ["scheduled", "scheduled"],
    });
  });

  it("refuses more ids than a follower ever names, naming the field", async () => {
    const ids = Array.from({ length: LIVE_IDS_MAX + 1 }, (_, i) => `s${i}`);
    const res = await SELF.fetch(`${base}/sends/live?ids=${ids.join(",")}`, { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request", field: "ids" });
    // Exactly the limit is fine, and a repeat is one id.
    const ok = await SELF.fetch(`${base}/sends/live?ids=${ids.slice(1).join(",")},s1`, {
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
  });

  it("answers an empty world with nothing to follow and nothing coming due", async () => {
    expect(await live()).toMatchObject({ sends: [], named: [], next_fire_at: null });
  });

  it("401s without auth", async () => {
    expect((await SELF.fetch(`${base}/sends/live`)).status).toBe(401);
  });
});
