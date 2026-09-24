import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeSendCursor, encodeSendCursor } from "../shared/cursor";
import {
  type SendFeedResponse,
  type SendListResponse,
  type SendResponse,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import * as posts from "../src/db/posts";
import { getConfig } from "../src/env";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { readAgainAt, SETTLE_FOLLOW_MS } from "../src/send/feed";
import { runSend } from "../src/send/loop";
import { cancel, freeze } from "../src/send/schedule";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { adminAuth } from "./support/auth";

// GET /sends/feed is what the admin pages, and any other client, follow instead of each
// polling its own endpoint (SPEC §8): every send that changed after a cursor, whichever
// client changed it and whether a write or the clock did, in the /progress shape, with when
// to read again. These pin what it reports after a cursor, what it lists without one, and
// the pace it sets.

const config = () => getConfig(env);
const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";

const tpl = (marker: string) =>
  `<div>{{ post.body }}<p>${marker} · {{ publication.name }}</p><a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

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

/** Put a send's row in the given state, the way the send loop would have left it. It takes
 *  no `rev`, so what it sets is something the clock, not a write, has to surface. */
async function setRow(id: string, fields: Record<string, number | string | null>): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c] ?? null), id)
    .run();
}

async function feed(since?: string): Promise<SendFeedResponse> {
  const q = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
  const res = await SELF.fetch(`${base}/sends/feed${q}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as SendFeedResponse;
}

async function listCursor(): Promise<string> {
  const res = await SELF.fetch(`${base}/sends`, { headers: AUTH });
  return ((await res.json()) as SendListResponse).cursor;
}

/** A cursor at the sequence now, as if it had been read at `at`: what a client holds when
 *  nothing was written since its read and the clock has moved on. */
async function cursorReadAt(at: number): Promise<string> {
  const seq = decodeSendCursor(await listCursor())?.seq;
  return encodeSendCursor({ seq: seq ?? 0, at });
}

const post = (path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method: "POST",
    headers: body === undefined ? AUTH : JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clearFakeOutbox();
});

describe("GET /sends/feed after a cursor", () => {
  it("reports a cancel, a move, and a new schedule of far-scheduled sends, whichever client made them, and nothing else", async () => {
    const far = Date.now() + 24 * 3_600_000;
    const dropped = await scheduledSend("Dropped", far);
    const moved = await scheduledSend("Moved", far);
    const untouched = await scheduledSend("Untouched", far);
    const { post: fresh } = await posts.createPost(
      env.DB,
      { subject: "Fresh", markdown: "# Hi\n\nbody" },
      "test",
    );
    const since = await listCursor();
    expect((await feed(since)).sends).toEqual([]); // nothing yet

    expect((await post(`/sends/${dropped.id}/cancel`)).status).toBe(200);
    const to = new Date(far + 3_600_000).toISOString();
    expect((await post(`/sends/${moved.id}/reschedule`, { fire_at: to })).status).toBe(200);
    const scheduled = await post(`/posts/${fresh.id}/schedule`, {
      fire_at: new Date(far).toISOString(),
    });
    expect(scheduled.status).toBe(201);

    const body = await feed(since);
    const got = Object.fromEntries(body.sends.map((s) => [s.subject, [s.state, s.phase]]));
    expect(got).toEqual({
      Dropped: ["canceled", "canceled"],
      Moved: ["scheduled", "scheduled"],
      Fresh: ["scheduled", "scheduled"],
    });
    expect(body.sends.find((s) => s.id === untouched.id)).toBeUndefined();
    expect(body.sends.find((s) => s.id === moved.id)?.fire_at).toBe(Date.parse(to));
    // Nothing moving on its own: about once a minute, so the other client's next change
    // shows within one read.
    expect(body.read_again_at).toBe(body.now + 60_000);

    // The new cursor is past all of it.
    expect((await feed(body.cursor)).sends).toEqual([]);
  });

  it("reports a far-scheduled send whose email a template change re-made", async () => {
    const put = (body: unknown) =>
      SELF.fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify(body),
      });
    expect((await put({ emailTemplate: tpl("v1") })).status).toBe(200);
    const remade = await scheduledSend("Remade", Date.now() + 24 * 3_600_000);
    const since = await listCursor();
    expect((await put({ emailTemplate: tpl("v2"), remake: [remade.id] })).status).toBe(200);
    expect((await feed(since)).sends.map((s) => [s.id, s.phase])).toEqual([
      [remade.id, "scheduled"],
    ]);
  });

  it("follows one send from its own read's cursor", async () => {
    const send = await scheduledSend("Mine", Date.now() + 3_600_000);
    const res = await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH });
    const { cursor } = (await res.json()) as SendResponse;
    expect((await feed(cursor)).sends).toEqual([]);
    await cancel(env, send.id);
    expect((await feed(cursor)).sends.map((s) => [s.id, s.phase])).toEqual([[send.id, "canceled"]]);
  });

  it("reports a send the clock turned due, with no write, once its fire time falls after the cursor's read", async () => {
    const now = Date.now();
    const due = await scheduledSend("Due", now - 10_000);
    await scheduledSend("Ahead", now + 3_600_000);
    const before = await feed(await cursorReadAt(now - 20_000));
    expect(before.sends.map((s) => [s.id, s.phase])).toEqual([[due.id, "due"]]);
    // A cursor read after the fire time already saw it due.
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send the clock made missed", async () => {
    const now = Date.now();
    const late = await scheduledSend("Late", now - MISSED_THRESHOLD_MS - 10_000);
    const body = await feed(await cursorReadAt(now - 20_000));
    expect(body.sends.map((s) => [s.id, s.attention.missed])).toEqual([[late.id, true]]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send the clock made stuck", async () => {
    const now = Date.now();
    const send = await scheduledSend("Long", now - STUCK_THRESHOLD_MS - 60_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - STUCK_THRESHOLD_MS - 10_000,
      audience_resolved_at: now - STUCK_THRESHOLD_MS - 10_000,
      c_pending: 5,
    });
    const body = await feed(await cursorReadAt(now - 20_000));
    expect(body.sends.map((s) => [s.id, s.attention.stuck])).toEqual([[send.id, true]]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send wedged when its lease ran out", async () => {
    const now = Date.now();
    const send = await scheduledSend("Wedged", now - 120_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - 100_000,
      audience_resolved_at: now - 100_000,
      c_in_flight: 3,
      c_accepted: 7,
      locked_until: now - 10_000,
    });
    const body = await feed(await cursorReadAt(now - 20_000));
    expect(body.sends.map((s) => [s.id, s.phase, s.attention.wedged])).toEqual([
      [send.id, "needs-attention", true],
    ]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a late receipt on a send past the hour it is followed at pace", async () => {
    await seedConfirmed("a@example.com");
    const send = await scheduledSend("Old", Date.now() - 1000);
    await runSend(env, send.id);
    await setRow(send.id, { completed_at: Date.now() - SETTLE_FOLLOW_MS - 60_000 });
    const since = await listCursor();
    expect((await feed()).sends).toEqual([]); // no longer listed as settling at pace
    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: `fake-${send.id}:a@example.com` },
    ]);
    const body = await feed(since);
    expect(body.sends.map((s) => [s.id, s.phase])).toEqual([[send.id, "complete"]]);
  });

  it("refuses a cursor it did not issue, naming the field", async () => {
    const res = await SELF.fetch(`${base}/sends/feed?since=not-a-cursor`, { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request", field: "since" });
  });
});

describe("GET /sends/feed without a cursor", () => {
  it("lists the due, sending, and settling sends, soonest fire first, with a cursor to follow from", async () => {
    const now = Date.now();
    await scheduledSend("Ahead", now + 3_600_000);
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
    // Still awaiting receipts, but done with longer ago than the hour it is followed at pace
    // (SPEC §6: some are never confirmed at all).
    const stale = await scheduledSend("Stale", now - SETTLE_FOLLOW_MS - 600_000);
    await setRow(stale.id, {
      status: "sent",
      completed_at: now - SETTLE_FOLLOW_MS - 1,
      c_accepted: 4,
    });
    const canceled = await scheduledSend("Canceled", now + 900_000);
    await cancel(env, canceled.id);

    const body = await feed();
    expect(body.sends.map((s) => s.subject)).toEqual(["Settling", "Sending", "Due"]);
    expect(Math.abs(body.now - now)).toBeLessThan(10_000);
    expect(body.read_again_at).toBe(body.now + 3000); // a send is due or sending
    expect(decodeSendCursor(body.cursor)?.at).toBe(body.now);

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
    const [row] = (await feed()).sends;
    const progress = await (
      await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH })
    ).json();
    const { id, post_id, subject, fire_at, started_at, completed_at, ...shape } = row!;
    expect(shape).toEqual(progress);
    expect(id).toBe(send.id);
  });

  it("eases to the idle pace once a due send is past the missed tolerance", async () => {
    const missed = await scheduledSend("Missed", Date.now() - MISSED_THRESHOLD_MS - 60_000);
    const body = await feed();
    expect(body.sends.map((s) => [s.id, s.attention.missed])).toEqual([[missed.id, true]]);
    expect(body.read_again_at).toBe(body.now + 60_000); // the sweep isn't running: nothing moves
    const due = await scheduledSend("Due", Date.now() - 30_000);
    expect((await feed()).read_again_at - body.now).toBeLessThan(10_000);
    await cancel(env, due.id);
  });

  it("answers an empty world with nothing to follow, read again in about a minute", async () => {
    const body = await feed();
    expect(body.sends).toEqual([]);
    expect(body.read_again_at).toBe(body.now + 60_000);
  });

  it("401s without auth", async () => {
    expect((await SELF.fetch(`${base}/sends/feed`)).status).toBe(401);
  });
});

describe("read_again_at", () => {
  const NOW = 1_700_000_000_000;
  const idle = { active: false, settlingSince: null, nextFireAt: null };
  const settling = (ago: number) => readAgainAt({ ...idle, settlingSince: NOW - ago }, NOW) - NOW;

  it("is 3 s while a send is due or sending, whatever else settles", () => {
    expect(readAgainAt({ ...idle, active: true }, NOW)).toBe(NOW + 3000);
    expect(
      readAgainAt({ active: true, settlingSince: NOW - 1_000_000, nextFireAt: null }, NOW),
    ).toBe(NOW + 3000);
  });

  it("follows receipts at the pace they arrive, by the youngest settling send: 3 s, 15 s, then 60 s", () => {
    expect(settling(0)).toBe(3000);
    expect(settling(119_000)).toBe(3000);
    expect(settling(121_000)).toBe(15_000);
    expect(settling(599_000)).toBe(15_000);
    expect(settling(601_000)).toBe(60_000);
    expect(settling(SETTLE_FOLLOW_MS + 1)).toBe(60_000); // past the hour: the idle read
  });

  it("is about once a minute with nothing moving, and never later than just past the next fire time", () => {
    expect(readAgainAt(idle, NOW)).toBe(NOW + 60_000);
    expect(readAgainAt({ ...idle, nextFireAt: NOW + 20_000 }, NOW)).toBe(NOW + 21_000);
    expect(readAgainAt({ ...idle, nextFireAt: NOW + 3_600_000 }, NOW)).toBe(NOW + 60_000);
    expect(readAgainAt({ ...idle, settlingSince: NOW, nextFireAt: NOW + 20_000 }, NOW)).toBe(
      NOW + 3000,
    );
  });

  it("is set from the whole table, not only the sends a read reports", async () => {
    const now = Date.now();
    const settled = await scheduledSend("Settling", now - 600_000);
    await setRow(settled.id, { status: "sent", completed_at: now - 300_000, c_accepted: 2 });
    const soon = await scheduledSend("Soon", now + 20_000);
    const since = await listCursor();
    const body = await feed(since);
    expect(body.sends).toEqual([]); // neither changed
    // Settling five minutes after dispatch: 15 s, sooner than the fire time's wake.
    expect(body.read_again_at).toBe(body.now + 15_000);
    await setRow(settled.id, { c_accepted: 0, c_delivered: 2 });
    const idleBody = await feed(since);
    expect(idleBody.read_again_at).toBe(Math.min(idleBody.now + 60_000, soon.fire_at + 1000));
  });
});
