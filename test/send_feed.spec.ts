import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeSendCursor, encodeSendCursor } from "../shared/cursor";
import type { PostListResponse } from "../shared/posts";
import {
  NO_RECEIPTS_AFTER_MS,
  type SendFeedResponse,
  type SendListResponse,
  type SendResponse,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { readAgainAt, SETTLE_FOLLOW_MS } from "../src/send/feed";
import { runSend } from "../src/send/loop";
import { cancel, onTheMinute } from "../src/send/schedule";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { has } from "./support/conditions";
import { frozenSend, resetDatabase, seedConfirmed, setRow, tpl } from "./support/fixtures";
import { AUTH, adminAuth, base, JSON_AUTH } from "./support/http";

// GET /api/sends/feed is what the admin pages, and any other client, follow instead of each
// polling its own endpoint (SPEC §8): every send that changed after a cursor, whichever
// client changed it and whether a write or the clock did, each as its view, with when
// to read again. These pin what it reports after a cursor, what it lists without one, and
// the pace it sets.

async function feed(since?: string): Promise<SendFeedResponse> {
  const q = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
  const res = await SELF.fetch(`${base}/api/sends/feed${q}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as SendFeedResponse;
}

async function listCursor(): Promise<string> {
  const res = await SELF.fetch(`${base}/api/sends`, { headers: AUTH });
  return ((await res.json()) as SendListResponse).cursor;
}

/** A cursor at the sequence now, as if it had been read at `at`: what a client holds when
 *  nothing was written since its read and the clock has moved on. */
async function cursorReadAt(at: number): Promise<string> {
  const seq = decodeSendCursor(await listCursor())?.seq;
  return encodeSendCursor({ seq: seq ?? 0, at });
}

/** A POST as the editor's signed-in publisher, or as `auth` when given. */
const post = (path: string, body?: unknown, auth: Record<string, string> = AUTH) =>
  SELF.fetch(`${base}${path}`, {
    method: "POST",
    headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

describe("GET /api/posts's cursor", () => {
  it("follows the listed posts' sends: a schedule and a cancel after the list read are reported", async () => {
    const far = Date.now() + 24 * 3_600_000;
    const listed = await frozenSend(far, { subject: "Listed" });
    const { post: draft } = await posts.createPost(
      env.DB,
      { subject: "Draft", markdown: "# Hi\n\nbody" },
      "test",
    );
    const res = await SELF.fetch(`${base}/api/posts?status=draft,scheduled`, { headers: AUTH });
    expect(res.status).toBe(200);
    const { cursor } = (await res.json()) as PostListResponse;
    expect(decodeSendCursor(cursor)).not.toBeNull();
    expect((await feed(cursor)).sends).toEqual([]); // nothing since the list read

    expect((await post(`/api/sends/${listed.id}/cancel`)).status).toBe(200);
    expect(
      (await post(`/api/posts/${draft.id}/schedule`, { fire_at: new Date(far).toISOString() }))
        .status,
    ).toBe(201);
    const got = (await feed(cursor)).sends.map((s) => [s.post_id, s.status]);
    expect(got).toEqual(
      expect.arrayContaining([
        [listed.post_id, "canceled"],
        [draft.id, "scheduled"],
      ]),
    );
    expect(got).toHaveLength(2);
  });
});

describe("GET /api/sends/feed after a cursor", () => {
  it("reports a cancel, a move, and a new schedule of far-scheduled sends, whichever client made them, and nothing else", async () => {
    const far = Date.now() + 24 * 3_600_000;
    const dropped = await frozenSend(far, { subject: "Dropped" });
    const moved = await frozenSend(far, { subject: "Moved" });
    const untouched = await frozenSend(far, { subject: "Untouched" });
    const { post: fresh } = await posts.createPost(
      env.DB,
      { subject: "Fresh", markdown: "# Hi\n\nbody" },
      "test",
    );
    const since = await listCursor();
    expect((await feed(since)).sends).toEqual([]); // nothing yet

    expect((await post(`/api/sends/${dropped.id}/cancel`)).status).toBe(200);
    const to = new Date(far + 3_600_000).toISOString();
    // The publisher in the editor cancels; Claude, a service principal, moves and schedules.
    const claude = await adminAuth({});
    expect((await post(`/api/sends/${moved.id}/reschedule`, { fire_at: to }, claude)).status).toBe(
      200,
    );
    const scheduled = await post(
      `/api/posts/${fresh.id}/schedule`,
      { fire_at: new Date(far).toISOString() },
      claude,
    );
    expect(scheduled.status).toBe(201);

    const body = await feed(since);
    const got = Object.fromEntries(body.sends.map((s) => [s.subject, [s.status, s.phase]]));
    expect(got).toEqual({
      Dropped: ["canceled", "canceled"],
      Moved: ["scheduled", "scheduled"],
      Fresh: ["scheduled", "scheduled"],
    });
    expect(body.sends.find((s) => s.id === untouched.id)).toBeUndefined();
    expect(body.sends.find((s) => s.id === moved.id)?.fire_at).toBe(onTheMinute(Date.parse(to)));
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
    const remade = await frozenSend(Date.now() + 24 * 3_600_000, { subject: "Remade" });
    const since = await listCursor();
    expect((await put({ emailTemplate: tpl("v2"), remake: [remade.id] })).status).toBe(200);
    expect((await feed(since)).sends.map((s) => [s.id, s.phase])).toEqual([
      [remade.id, "scheduled"],
    ]);
  });

  it("follows one send from its own read's cursor", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, { subject: "Mine" });
    const res = await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH });
    const { cursor } = (await res.json()) as SendResponse;
    expect((await feed(cursor)).sends).toEqual([]);
    await cancel(env, send.id);
    expect((await feed(cursor)).sends.map((s) => [s.id, s.phase])).toEqual([[send.id, "canceled"]]);
  });

  it("reports a send the clock turned due, with no write, once its fire time falls after the cursor's read", async () => {
    const now = Date.now();
    const due = await frozenSend(now - 10_000, { subject: "Due" });
    await frozenSend(now + 3_600_000, { subject: "Ahead" });
    const before = await feed(await cursorReadAt(now - 20_000));
    expect(before.sends.map((s) => [s.id, s.phase])).toEqual([[due.id, "due"]]);
    // A cursor read after the fire time already saw it due.
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send the clock made missed", async () => {
    const now = Date.now();
    const late = await frozenSend(now - MISSED_THRESHOLD_MS - 10_000, { subject: "Late" });
    const body = await feed(await cursorReadAt(now - 20_000));
    expect(body.sends.map((s) => [s.id, has(s, "missed")])).toEqual([[late.id, true]]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send the clock made stuck", async () => {
    const now = Date.now();
    const send = await frozenSend(now - STUCK_THRESHOLD_MS - 60_000, { subject: "Long" });
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

  it("reports a sent send the clock made silent, with no receipt long after dispatch", async () => {
    const now = Date.now();
    const send = await frozenSend(now - NO_RECEIPTS_AFTER_MS - 120_000, { subject: "Quiet" });
    await setRow(send.id, {
      status: "sent",
      started_at: now - NO_RECEIPTS_AFTER_MS - 60_000,
      audience_resolved_at: now - NO_RECEIPTS_AFTER_MS - 60_000,
      completed_at: now - NO_RECEIPTS_AFTER_MS - 10_000,
      c_accepted: 5,
    });
    const body = await feed(await cursorReadAt(now - 20_000));
    expect(body.sends.map((s) => [s.id, has(s, "no_receipts")])).toEqual([[send.id, true]]);
    expect((await feed(await cursorReadAt(now - 5_000))).sends).toEqual([]);
  });

  it("reports a send wedged by the write that released it, and not when a lease merely runs out", async () => {
    const now = Date.now();
    const send = await frozenSend(now - 120_000, { subject: "Wedged" });
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
    const send = await frozenSend(Date.now() - 1000, { subject: "Old" });
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
    const res = await SELF.fetch(`${base}/api/sends/feed?since=not-a-cursor`, { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request", field: "since" });
  });
});

describe("GET /api/sends/feed without a cursor", () => {
  it("lists the due, sending, and settling sends, soonest fire first, with a cursor to follow from", async () => {
    const now = Date.now();
    await frozenSend(now + 3_600_000, { subject: "Ahead" });
    const due = await frozenSend(now - 10_000, { subject: "Due" });
    const sending = await frozenSend(now - 120_000, { subject: "Sending" });
    await setRow(sending.id, {
      status: "sending",
      started_at: now - 110_000,
      audience_resolved_at: now - 110_000,
      c_pending: 5,
      c_accepted: 3,
    });
    const settling = await frozenSend(now - 300_000, { subject: "Settling" });
    await setRow(settling.id, {
      status: "sent",
      started_at: now - 290_000,
      completed_at: now - 240_000,
      c_accepted: 2,
      c_delivered: 6,
    });
    const complete = await frozenSend(now - 600_000, { subject: "Complete" });
    await setRow(complete.id, { status: "sent", completed_at: now - 500_000, c_delivered: 8 });
    // Still awaiting receipts, but done with longer ago than the hour it is followed at pace
    // (SPEC §6: some are never confirmed at all).
    const stale = await frozenSend(now - SETTLE_FOLLOW_MS - 600_000, { subject: "Stale" });
    await setRow(stale.id, {
      status: "sent",
      completed_at: now - SETTLE_FOLLOW_MS - 1,
      c_accepted: 4,
    });
    const canceled = await frozenSend(now + 900_000, { subject: "Canceled" });
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
      "progressing", // between ticks: work remains, nothing in flight, nothing failed
      5,
      3,
    ]);
    expect(g?.started_at).toBe(now - 110_000);
    expect([s?.status, s?.phase, s?.completed_at]).toEqual(["sent", "settling", now - 240_000]);
    expect(s?.delivery.confirmed).toBe(6);
  });

  it("reads a send the same as GET /api/sends/:id and the list do, as one view", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    const send = await frozenSend(Date.now() - 1000, { subject: "Live" });
    failFakeSendBatch(1);
    await runSend(env, send.id); // left sending, the batch back in the queue
    const [row] = (await feed()).sends;
    const one = (
      (await (
        await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH })
      ).json()) as SendResponse
    ).send;
    const listed = (
      (await (await SELF.fetch(`${base}/api/sends`, { headers: AUTH })).json()) as SendListResponse
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
    const missed = await frozenSend(Date.now() - MISSED_THRESHOLD_MS - 60_000, {
      subject: "Missed",
    });
    const body = await feed();
    expect(body.sends.map((s) => [s.id, has(s, "missed")])).toEqual([[missed.id, true]]);
    expect(body.read_again_at).toBe(body.now + 60_000); // the sweep isn't running: nothing moves
    await frozenSend(Date.now() - 30_000, { subject: "Due" });
    expect((await feed()).read_again_at - body.now).toBeLessThan(10_000);
  });

  it("answers an empty world with nothing to follow, read again in about a minute", async () => {
    const body = await feed();
    expect(body.sends).toEqual([]);
    expect(body.read_again_at).toBe(body.now + 60_000);
  });

  it("401s without auth", async () => {
    expect((await SELF.fetch(`${base}/api/sends/feed`)).status).toBe(401);
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
    const settled = await frozenSend(now - 600_000, { subject: "Settling" });
    await setRow(settled.id, { status: "sent", completed_at: now - 300_000, c_accepted: 2 });
    const soon = await frozenSend(now + 20_000, { subject: "Soon" });
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
  SELF.fetch(`${base}/api/sends/feed${query}`, { headers: AUTH });

describe("GET /api/sends/feed refuses a cursor ahead of the database", () => {
  it("answers a sequence above the current one with cursor_ahead, naming the field", async () => {
    const now = Date.now();
    await frozenSend(now + 3_600_000, { subject: "Far" });
    const seq = decodeSendCursor(await listCursor())?.seq ?? 0;
    // A cursor from before a local reset or a restore: far past anything this database holds.
    const res = await feedStatus(`?since=${encodeSendCursor({ seq: seq + 5000, at: now })}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; field: string; cursor: string };
    expect(body).toMatchObject({ error: "cursor_ahead", field: "since" });
    expect(decodeSendCursor(body.cursor)?.seq).toBe(seq);
  });

  it("answers a read time after the server's clock with cursor_ahead, beyond a minute's drift", async () => {
    const seq = decodeSendCursor(await listCursor())?.seq ?? 0;
    expect(
      (await feedStatus(`?since=${encodeSendCursor({ seq, at: Date.now() + 10 * 60_000 })}`))
        .status,
    ).toBe(409);
    expect(
      (await feedStatus(`?since=${encodeSendCursor({ seq, at: Date.now() + 5_000 })}`)).status,
    ).toBe(200);
  });
});

describe("GET /api/sends/feed reports removed sends", () => {
  it("reports a canceled send deleted with its post as removed, after the cursor only", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, { subject: "Dropped" });
    await cancel(env, send.id);
    const before = await listCursor();
    const del = await SELF.fetch(`${base}/api/posts/${send.post_id}`, {
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

describe("GET /api/sends/feed limit", () => {
  it("stops at the limit with more, and the next read from its cursor reports the rest once each", async () => {
    const since = await listCursor();
    const far = Date.now() + 24 * 3_600_000;
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await frozenSend(far + i, { subject: `S${i}` }));
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
    const a = await frozenSend(now + 1000, { subject: "A" });
    const b = await frozenSend(now + 2000, { subject: "B" });
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

describe("GET /api/sends/feed paces from each send's next change", () => {
  it("does not hurry for a send the provider refuses: it reads at the retry", async () => {
    const now = Date.now();
    const send = await frozenSend(now - 120_000, { subject: "Refused" });
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
    const send = await frozenSend(now - 120_000, { subject: "Unavailable" });
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

  it("does not hurry for a wedged send: only Resolve moves it", async () => {
    const now = Date.now();
    const send = await frozenSend(now - 120_000, { subject: "Wedged" });
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
    expect(body.sends[0]?.next_change_at).toBeNull();
    expect(body.read_again_at).toBe(body.now + 60_000);
  });

  it("follows closely while a run holds the send, or work waits for the next tick", async () => {
    const now = Date.now();
    const send = await frozenSend(now - 120_000, { subject: "Running" });
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

describe("GET /api/sends/:id shape fixes", () => {
  it("links the archive once the send starts, and leaves a halt's times null rather than now", async () => {
    const now = Date.now();
    const send = await frozenSend(now + 3_600_000, { subject: "Unpublished" });
    let body = (await (
      await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH })
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
      await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH })
    ).json()) as SendResponse;
    expect(body.send.provider.halt).toMatchObject({ since: null, retry_at: null });
    // Published from the start, so a halted send in flight still links its page.
    expect(body.send.links.archive).toMatch(/\/archive\/[^/]+$/);
  });
});
