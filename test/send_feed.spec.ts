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
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { readAgainAt, SETTLE_FOLLOW_MS } from "../src/send/feed";
import { runSend } from "../src/send/loop";
import { cancel, freeze } from "../src/send/schedule";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { adminAuth } from "./support/auth";
import { has } from "./support/conditions";

// GET /sends/feed is what the admin pages, and any other client, follow instead of each
// polling its own endpoint (SPEC §8): every send that changed after a cursor, whichever
// client changed it and whether a write or the clock did, each as its view, with when
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
    const got = Object.fromEntries(body.sends.map((s) => [s.subject, [s.status, s.phase]]));
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
    expect(body.sends.map((s) => [s.id, has(s, "missed")])).toEqual([[late.id, true]]);
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
    expect(body.sends.map((s) => [s.id, has(s, "stuck")])).toEqual([[send.id, true]]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send wedged by the write that released it, and not when a lease merely runs out", async () => {
    const now = Date.now();
    const send = await scheduledSend("Wedged", now - 120_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - 100_000,
      audience_resolved_at: now - 100_000,
      c_in_flight: 3,
      c_accepted: 7,
      locked_until: now - 10_000, // a run cut off: its lease ran out, and no run has looked
    });
    const since = await cursorReadAt(now - 20_000);
    expect((await feed(since)).sends).toEqual([]); // nothing a reader sees has changed
    // The next run looks, finds nothing it may re-send, and releases the send.
    const lease = await sends.acquireLease(env.DB, send.id, Date.now(), 60_000);
    await sends.releaseLease(env.DB, send.id, lease!);
    const body = await feed(since);
    expect(body.sends.map((s) => [s.id, s.phase, has(s, "wedged")])).toEqual([
      [send.id, "needs-attention", true],
    ]);
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
    expect([d?.status, d?.phase, has(d, "missed")]).toEqual(["scheduled", "due", false]);
    expect(d).toMatchObject({ id: due.id, post_id: due.post_id, fire_at: due.fire_at });
    expect([g?.status, g?.phase, g?.counts.pending, g?.counts.accepted]).toEqual([
      "sending",
      "backing-off", // work remains, nothing in flight
      5,
      3,
    ]);
    expect(g?.started_at).toBe(now - 110_000);
    expect([s?.status, s?.phase, s?.completed_at]).toEqual(["sent", "settling", now - 240_000]);
    expect(s?.delivery.confirmed).toBe(6);
  });

  it("reads a send the same as GET /sends/:id and the list do, as one view", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    const send = await scheduledSend("Live", Date.now() - 1000);
    failFakeSendBatch(1);
    await runSend(env, send.id); // left sending, the batch back in the queue
    const [row] = (await feed()).sends;
    const one = (
      (await (
        await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH })
      ).json()) as SendResponse
    ).send;
    const listed = (
      (await (await SELF.fetch(`${base}/sends`, { headers: AUTH })).json()) as SendListResponse
    ).sends[0];
    // The same view on every route, but for the moment each was read at.
    const at = (v: typeof row) => ({
      ...v,
      as_of: 0,
      next_change_at: 0,
      dispatch: { ...v!.dispatch, rate_per_min: 0, eta_ms: 0 },
    });
    expect(at(row)).toEqual(at(one));
    expect(at(row)).toEqual(at(listed));
    expect(row?.id).toBe(send.id);
  });

  it("eases to the idle pace once a due send is past the missed tolerance", async () => {
    const missed = await scheduledSend("Missed", Date.now() - MISSED_THRESHOLD_MS - 60_000);
    const body = await feed();
    expect(body.sends.map((s) => [s.id, has(s, "missed")])).toEqual([[missed.id, true]]);
    expect(body.read_again_at).toBe(body.now + 60_000); // the sweep isn't running: nothing moves
    const _due = await scheduledSend("Due", Date.now() - 30_000);
    expect((await feed()).read_again_at - body.now).toBeLessThan(10_000);
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
  const idle = { moving: false, settlingSince: null, nextChangeAt: null };
  const settling = (ago: number) => readAgainAt({ ...idle, settlingSince: NOW - ago }, NOW) - NOW;

  it("is 3 s while a send can move now, whatever else settles", () => {
    expect(readAgainAt({ ...idle, moving: true }, NOW)).toBe(NOW + 3000);
    expect(
      readAgainAt({ moving: true, settlingSince: NOW - 1_000_000, nextChangeAt: null }, NOW),
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

  it("is about once a minute with nothing moving, and never later than just past the next change", () => {
    expect(readAgainAt(idle, NOW)).toBe(NOW + 60_000);
    expect(readAgainAt({ ...idle, nextChangeAt: NOW + 20_000 }, NOW)).toBe(NOW + 21_000);
    expect(readAgainAt({ ...idle, nextChangeAt: NOW + 3_600_000 }, NOW)).toBe(NOW + 60_000);
    expect(readAgainAt({ ...idle, settlingSince: NOW, nextChangeAt: NOW + 20_000 }, NOW)).toBe(
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

const feedStatus = async (query: string) =>
  SELF.fetch(`${base}/sends/feed${query}`, { headers: AUTH });

describe("GET /sends/feed refuses a cursor ahead of the database", () => {
  it("answers a sequence above the current one with cursor_ahead, naming the field", async () => {
    const now = Date.now();
    await scheduledSend("Far", now + 3_600_000);
    const seq = decodeSendCursor(await listCursor())?.seq ?? 0;
    // A cursor from before a local reset or a restore: far past anything this database holds.
    const res = await feedStatus(`?since=${seq + 5000}.${now}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; field: string; cursor: string };
    expect(body).toMatchObject({ error: "cursor_ahead", field: "since" });
    expect(decodeSendCursor(body.cursor)?.seq).toBe(seq);
  });

  it("answers a read time after the server's clock with cursor_ahead, beyond a minute's drift", async () => {
    const seq = decodeSendCursor(await listCursor())?.seq ?? 0;
    expect((await feedStatus(`?since=${seq}.${Date.now() + 10 * 60_000}`)).status).toBe(409);
    expect((await feedStatus(`?since=${seq}.${Date.now() + 5_000}`)).status).toBe(200);
  });
});

describe("GET /sends/feed reports removed sends", () => {
  it("reports a canceled send deleted with its post as removed, after the cursor only", async () => {
    const send = await scheduledSend("Dropped", Date.now() + 3_600_000);
    await cancel(env, send.id);
    const before = await listCursor();
    const del = await SELF.fetch(`${base}/posts/${send.post_id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBeLessThan(300);

    const body = await feed(before);
    expect(body.sends).toEqual([]);
    expect(body.removed.map((r) => r.id)).toEqual([send.id]);
    // The removal is a change in the sequence: the cursor handed back is past it.
    expect(decodeSendCursor(body.cursor)?.seq).toBe(body.removed[0]?.rev);
    expect((await feed(body.cursor)).removed).toEqual([]);
    expect((await feed()).removed).toEqual([]); // without a cursor nothing is removed
  });
});

describe("GET /sends/feed limit", () => {
  it("stops at the limit with more, and the next read from its cursor reports the rest once each", async () => {
    const since = await listCursor();
    const far = Date.now() + 24 * 3_600_000;
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await scheduledSend(`S${i}`, far + i));
    }
    const seen: string[] = [];
    let cursor = since;
    let reads = 0;
    for (;;) {
      const res = await feedStatus(`?since=${encodeURIComponent(cursor)}&limit=2`);
      const body = (await res.json()) as SendFeedResponse;
      reads += 1;
      seen.push(...body.sends.map((s) => s.id));
      cursor = body.cursor;
      if (!body.more) {
        break;
      }
      expect(body.sends).toHaveLength(2);
      expect(body.read_again_at).toBe(body.now); // more waits: read again at once
    }
    expect(reads).toBe(3);
    expect(seen.sort()).toEqual(made.map((s) => s.id).sort());
  });

  it("reports every send the clock changed, whatever the limit", async () => {
    const now = Date.now();
    const a = await scheduledSend("A", now + 1000);
    const b = await scheduledSend("B", now + 2000);
    // Both writes before the cursor, read 5 s ago; only the clock has moved them since.
    const since = await cursorReadAt(now - 5000);
    await setRow(a.id, { fire_at: now - 1000 });
    await setRow(b.id, { fire_at: now - 500 });
    const res = await feedStatus(`?since=${encodeURIComponent(since)}&limit=1`);
    const body = (await res.json()) as SendFeedResponse;
    expect(body.sends.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(body.more).toBe(false);
  });

  it("refuses a limit that is not a whole number from 1 to 500, naming the field", async () => {
    for (const bad of ["0", "501", "abc", "2.5", "-1"]) {
      const res = await feedStatus(`?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field: "limit" });
    }
  });
});

describe("GET /sends/feed paces from each send's next change", () => {
  it("does not hurry for a send the provider refuses: it reads at the retry", async () => {
    const now = Date.now();
    const send = await scheduledSend("Refused", now - 120_000);
    const retryAt = now + 5 * 60_000;
    await setRow(send.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_pending: 5,
      halt_reason: "account",
      halt_cause: "quota",
      halt_error: "Daily message quota exceeded",
      halted_at: now - 100_000,
      halt_retries: 1,
      halt_retry_at: retryAt,
    });
    const body = await feed();
    const [s] = body.sends;
    expect(has(s, "refused")).toBe(true);
    // The sweep takes it at the first tick within half a tick of the retry.
    expect(s?.next_change_at).toBe(retryAt - 30_000);
    expect(body.read_again_at).toBe(body.now + 60_000); // the retry is further off than a minute
  });

  it("wakes just past a halt's retry when that comes within the minute", async () => {
    const now = Date.now();
    const send = await scheduledSend("Unavailable", now - 120_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_pending: 5,
      halt_reason: "unavailable",
      halt_cause: "outage",
      halt_error: "503",
      halted_at: now - 20_000,
      halt_retries: 1,
      halt_retry_at: now + 50_000,
    });
    const body = await feed();
    expect(body.sends[0]?.phase).toBe("backing-off");
    expect(body.read_again_at).toBe(now + 50_000 - 30_000 + 1000);
  });

  it("does not hurry for a wedged send: only Resolve or the in-flight-too-long flag moves it", async () => {
    const now = Date.now();
    const send = await scheduledSend("Wedged", now - 120_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_in_flight: 2,
      c_accepted: 8,
      locked_until: null,
    });
    const body = await feed();
    expect(has(body.sends[0], "wedged")).toBe(true);
    expect(body.sends[0]?.next_change_at).toBe(now - 110_000 + STUCK_THRESHOLD_MS);
    expect(body.read_again_at).toBe(body.now + 60_000);
  });

  it("follows closely while a run holds the send, or work waits for the next tick", async () => {
    const now = Date.now();
    const send = await scheduledSend("Running", now - 120_000);
    await setRow(send.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_in_flight: 2,
      locked_until: now + 60_000,
    });
    let body = await feed();
    expect(body.sends[0]?.next_change_at).toBe(body.now);
    expect(body.read_again_at).toBe(body.now + 3000);
    await setRow(send.id, { c_in_flight: 0, c_pending: 2, locked_until: null });
    body = await feed();
    expect(body.read_again_at).toBe(body.now + 3000);
  });
});

describe("GET /sends/:id shape fixes", () => {
  it("links the archive only once the send is sent, and leaves a halt's times null rather than now", async () => {
    const now = Date.now();
    const send = await scheduledSend("Unpublished", now + 3_600_000);
    let body = (await (
      await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH })
    ).json()) as SendResponse;
    expect(body.send.links.archive).toBeNull();

    await setRow(send.id, {
      status: "sending",
      started_at: now,
      c_pending: 1,
      halt_reason: "unavailable",
      halt_error: "503",
    });
    body = (await (
      await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH })
    ).json()) as SendResponse;
    expect(body.send.provider.halt).toMatchObject({ since: null, retry_at: null });
  });
});
