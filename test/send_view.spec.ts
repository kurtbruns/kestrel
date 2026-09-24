import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeSendCursor } from "../shared/cursor";
import type {
  ResolveResponse,
  ScheduleResponse,
  SendActionResponse,
  SendResponse,
  SendView,
} from "../shared/sends";
import * as posts from "../src/db/posts";
import type { SendRow } from "../src/db/sends";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { freeze } from "../src/send/schedule";
import { tickEstimate } from "../src/send/view";
import { adminAuth } from "./support/auth";
import { viewOf } from "./support/view";

// One `SendView` on every route (SPEC §8): the list, the send, the feed, and every action's
// answer carry the same shape, with `rev` to tell two apart and a cursor to follow from; the
// frozen bodies at their own route; `GET /sends/:id` tagged so an unchanged send is a 304.

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

async function frozenSend(fireAt: number, subject = "Subj", markdown = "# Hi\n\nbody") {
  const { post } = await posts.createPost(env.DB, { subject, markdown }, "test");
  return freeze(env, getConfig(env), post, fireAt);
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
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM subscribers"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clearFakeOutbox();
});

/** Every key a `SendView` carries, and none else: nothing internal on the wire. */
const VIEW_KEYS = [
  "actions",
  "as_of",
  "audience",
  "completed_at",
  "conditions",
  "counts",
  "delivery",
  "dispatch",
  "fire_at",
  "id",
  "links",
  "next_change_at",
  "phase",
  "post_id",
  "provider",
  "remade_at",
  "rev",
  "scheduled_at",
  "started_at",
  "status",
  "subject",
  "tested_at",
].sort();
const expectView = (v: SendView | undefined) =>
  expect(Object.keys(v ?? {}).sort()).toEqual(VIEW_KEYS);

describe("one SendView on every route", () => {
  it("answers the list, the send, the feed, and every action with the view and a cursor, never the frozen bodies or the lease", async () => {
    const fireAt = Date.now() + 3_600_000;
    const { post: draft } = await posts.createPost(env.DB, { subject: "Owls", markdown: "x" }, "t");
    const scheduled = (await readJson(
      await post(`/posts/${draft.id}/schedule`, { fire_at: fireAt }),
    )) as ScheduleResponse;
    expectView(scheduled.send);
    expect(decodeSendCursor(scheduled.cursor)).not.toBeNull();
    const id = scheduled.send.id;

    const moved = (await readJson(
      await post(`/sends/${id}/reschedule`, { fire_at: fireAt + 60_000 }),
    )) as SendActionResponse;
    expectView(moved.send);
    expect(moved.send.rev).toBeGreaterThan(scheduled.send.rev); // the newer answer, by rev
    expect(decodeSendCursor(moved.cursor)?.seq).toBeGreaterThanOrEqual(moved.send.rev);

    const list = await readJson(await SELF.fetch(`${base}/sends`, { headers: AUTH }));
    expectView(list.sends[0]);
    const one = (await readJson(
      await SELF.fetch(`${base}/sends/${id}`, { headers: AUTH }),
    )) as SendResponse;
    expectView(one.send);
    const feed = await readJson(
      await SELF.fetch(`${base}/sends/feed?since=${encodeURIComponent(scheduled.cursor)}`, {
        headers: AUTH,
      }),
    );
    expectView(feed.sends[0]);

    const canceled = (await readJson(await post(`/sends/${id}/cancel`))) as SendActionResponse;
    expectView(canceled.send);
    expect([canceled.send.status, canceled.send.phase]).toEqual(["canceled", "canceled"]);
    for (const view of [scheduled.send, moved.send, list.sends[0], one.send, canceled.send]) {
      expect(view.links.email_html).toBe(`/sends/${id}/email?format=html`);
      expect(view.links.archive).toBeNull(); // not sent: nothing published to link
    }
  });

  it("gives the audience as an estimate until it fires, and links the published post once sent", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const before = (
      (await readJson(
        await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH }),
      )) as SendResponse
    ).send;
    expect(before.audience).toEqual({ count: 0, fixed: false, fixed_at: null });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sends SET status = 'sent', started_at = ?, completed_at = ?, audience_resolved_at = ?, recipient_count = 3, c_accepted = 3 WHERE id = ?",
      ).bind(now, now, now, send.id),
      env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(send.post_id),
    ]);
    const after = (
      (await readJson(
        await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH }),
      )) as SendResponse
    ).send;
    expect(after.audience).toEqual({ count: 3, fixed: true, fixed_at: now });
    const slug = (await posts.getPost(env.DB, send.post_id))?.slug;
    expect(after.links.archive).toMatch(new RegExp(`/${slug}$`));
  });

  it("answers Resolve with the view beside what it did", async () => {
    const send = await frozenSend(Date.now() - 1000);
    await env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, attempts, updated_at) VALUES (?, 'a@example.com', 'dispatched', 0, ?)",
    )
      .bind(send.id, Date.now())
      .run();
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, audience_resolved_at = ? WHERE id = ?",
    )
      .bind(Date.now(), Date.now(), send.id)
      .run();
    await sends.recomputeSendCounters(env.DB, send.id);
    const res = (await readJson(
      await post(`/sends/${send.id}/resolve`, { resolution: "unsent" }),
    )) as ResolveResponse;
    expectView(res.send);
    expect([res.resolved, res.completed, res.send.status]).toEqual([1, true, "sent"]);
  });

  it("gives no time to finish while the send backs off, and one between ticks", async () => {
    const send = await frozenSend(Date.now() - 60_000);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 5, c_accepted = 5 WHERE id = ?",
    )
      .bind(now - 60_000, send.id)
      .run();
    const read = async () =>
      (
        (await readJson(
          await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH }),
        )) as SendResponse
      ).send;
    // Paused only by the tick's budget: still handing off, at the pace since the start.
    const between = await read();
    expect(between.phase).toBe("progressing");
    expect(between.dispatch.eta_ms).not.toBeNull();

    await env.DB.prepare(
      "UPDATE sends SET halt_reason = 'unavailable', halt_error = '503', halted_at = ? WHERE id = ?",
    )
      .bind(now, send.id)
      .run();
    const paused = await read();
    expect(paused.phase).toBe("backing-off");
    expect(paused.dispatch.rate_per_min).not.toBeNull();
    expect(paused.dispatch.eta_ms).toBeNull();
  });
});

// The time to finish counts sweep ticks (SPEC §6, §8): a large send hands off a burst each
// minute, so its finish is the minute of the last tick it needs, never an average rate
// over the seconds since the last burst. The case is the one observed: 1,045 recipients at
// about 400 a tick.
describe("the time to finish, in ticks", () => {
  const MIN = 60_000;
  // A minute boundary well clear of the test's own clock, and the start tick's run just after it.
  const T = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  const started = T + 400;
  const TOTAL = 1045;

  function row(done: number, over: Partial<SendRow> = {}): SendRow {
    return {
      id: "s",
      post_id: "p",
      status: "sending",
      fire_at: T,
      rendered_html: "",
      rendered_text: "",
      subject: "s",
      recipient_count: TOTAL,
      locked_until: null,
      scheduled_at: T - 10 * MIN,
      started_at: started,
      completed_at: null,
      audience_resolved_at: started,
      remade_at: null,
      tested_at: null,
      halt_reason: null,
      halt_cause: null,
      halt_error: null,
      halted_at: null,
      halt_retries: 0,
      halt_retry_at: null,
      c_pending: TOTAL - done,
      c_in_flight: 0,
      c_accepted: done,
      c_delivered: 0,
      c_bounced: 0,
      c_complained: 0,
      c_skipped: 0,
      c_unsent: 0,
      rev: 0,
      ...over,
    };
  }
  const dispatchAt = (r: SendRow, now: number, hasRetries = false) =>
    viewOf(r, "fake", hasRetries, now).dispatch;
  const running = (now: number) => ({ locked_until: now + 5 * MIN });

  it("between ticks after the first tick's 400, finishes on the tick two minutes on", () => {
    const now = T + 16_000;
    const d = dispatchAt(row(400), now);
    // Two more ticks: the next minute's and the one after, which is the last.
    expect(d.eta_ms).toBe(T + 2 * MIN + 5_000 - now);
    expect(d.rate_per_min).toBe(400);
  });

  it("between ticks after 800 over two ticks, finishes on the next minute's tick", () => {
    const now = T + MIN + 19_000;
    const d = dispatchAt(row(800), now);
    expect(d.eta_ms).toBe(T + 2 * MIN + 5_000 - now);
    expect(d.rate_per_min).toBe(400);
  });

  it("takes this minute's tick as still to come just after the boundary", () => {
    // The cron has fired but the tick has not yet taken the lease: 400 over one tick, and
    // the next tick is this one.
    const now = T + MIN + 500;
    const d = dispatchAt(row(400), now);
    expect(d.rate_per_min).toBe(400);
    expect(d.eta_ms).toBe(T + 2 * MIN + 5_000 - now);
  });

  it("gives no time to finish or rate before the first tick has finished", () => {
    const now = T + 8_000;
    const d = dispatchAt(
      row(250, { c_pending: TOTAL - 350, c_in_flight: 100, ...running(now) }),
      now,
    );
    expect([d.rate_per_min, d.eta_ms]).toEqual([null, null]);
  });

  it("finishes within the running tick when the rest fits in it", () => {
    // The third tick is running with the last 125 to go: it ends this tick, in seconds.
    const now = T + 2 * MIN + 3_000;
    const d = dispatchAt(row(920, running(now)), now);
    expect(d.eta_ms).toBe(2_000);
    expect(d.eta_ms).toBeLessThan(MIN);
  });

  it("while a later tick runs with more than it can carry, finishes on a tick ahead", () => {
    // The second tick, part way: the rest needs the next minute's tick too.
    const now = T + MIN + 5_000;
    const d = dispatchAt(row(600, running(now)), now);
    expect(d.eta_ms).toBe(T + 2 * MIN + 5_000 - now);
  });

  it("gives no time to finish while backing off or halted", () => {
    const now = T + 16_000;
    expect(dispatchAt(row(400), now, true).eta_ms).toBeNull();
    const halted = row(400, {
      halt_reason: "unavailable",
      halt_error: "503",
      halted_at: now,
      halt_retry_at: now + MIN,
    });
    expect(viewOf(halted, "fake", false, now).phase).toBe("backing-off");
    expect(dispatchAt(halted, now).eta_ms).toBeNull();
  });

  it("counts a send that fits one tick as finishing at once", () => {
    expect(tickEstimate(started, 400, 400, false, T + 30_000)).toEqual({
      perTick: 400,
      finishAt: T + 30_000,
    });
  });
});

describe("GET /sends/:id is tagged", () => {
  it("answers 304 while nothing about the send has changed, and 200 once a write or the clock changes it", async () => {
    const send = await frozenSend(Date.now() + 2_000);
    const first = await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH });
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"\d+-[0-9a-z]+"$/);
    const again = await SELF.fetch(`${base}/sends/${send.id}`, {
      headers: { ...AUTH, "if-none-match": etag ?? "" },
    });
    expect(again.status).toBe(304);
    // The clock alone: the fire time passes and the send reads due, with no write.
    await new Promise((r) => setTimeout(r, 2_100));
    const due = await SELF.fetch(`${base}/sends/${send.id}`, {
      headers: { ...AUTH, "if-none-match": etag ?? "" },
    });
    expect(due.status).toBe(200);
    expect(((await due.json()) as SendResponse).send.phase).toBe("due");
    // An action's If-Match takes the ETag as well as the bare rev.
    const moved = await SELF.fetch(`${base}/sends/${send.id}/reschedule`, {
      method: "POST",
      headers: { ...JSON_AUTH, "if-match": etag ?? "" },
      body: JSON.stringify({ fire_at: Date.now() + 3_600_000 }),
    });
    expect(moved.status).toBe(409); // due: the window has closed, but the tag was accepted
    expect(((await moved.json()) as { error: string }).error).toBe("window_closed");
  });
});

describe("the ETag follows the words the clock changes", () => {
  it("changes as a missed send's minutes late do, with no write", async () => {
    const send = await frozenSend(Date.now() - 20 * 60_000);
    const first = await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH });
    const etag = first.headers.get("etag") ?? "";
    // A minute later by the send's own clock: the fire time a minute further back, with no rev.
    await env.DB.prepare("UPDATE sends SET fire_at = fire_at - 60000 WHERE id = ?")
      .bind(send.id)
      .run();
    const later = await SELF.fetch(`${base}/sends/${send.id}`, {
      headers: { ...AUTH, "if-none-match": etag },
    });
    expect(later.status).toBe(200);
    expect(later.headers.get("etag")).not.toBe(etag);
  });
});

describe("the frozen email at its own route", () => {
  it("serves the html and text a send froze, and refuses another format", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, "Owls", "# Owls\n\nhoot");
    const row = await sends.getSend(env.DB, send.id);
    const htmlRes = await SELF.fetch(`${base}/sends/${send.id}/email`, { headers: AUTH });
    expect(htmlRes.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await htmlRes.text()).toBe(row?.rendered_html);
    const text = await SELF.fetch(`${base}/sends/${send.id}/email?format=text`, { headers: AUTH });
    expect(text.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await text.text()).toBe(row?.rendered_text);
    const bad = await SELF.fetch(`${base}/sends/${send.id}/email?format=pdf`, { headers: AUTH });
    expect(bad.status).toBe(400);
    expect(await readJson(bad)).toMatchObject({ field: "format" });
    expect((await SELF.fetch(`${base}/sends/nope/email`, { headers: AUTH })).status).toBe(404);
  });

  it("no longer serves /progress: the send's view and the feed carry it", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    expect((await SELF.fetch(`${base}/sends/${send.id}/progress`, { headers: AUTH })).status).toBe(
      404,
    );
  });
});
