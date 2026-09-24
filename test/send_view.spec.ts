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
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { freeze } from "../src/send/schedule";
import { adminAuth } from "./support/auth";

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

  it("gives no time to finish while the send is paused", async () => {
    const send = await frozenSend(Date.now() - 60_000);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 5, c_accepted = 5 WHERE id = ?",
    )
      .bind(now - 60_000, send.id)
      .run();
    const paused = (
      (await readJson(
        await SELF.fetch(`${base}/sends/${send.id}`, { headers: AUTH }),
      )) as SendResponse
    ).send;
    expect(paused.phase).toBe("backing-off");
    expect(paused.dispatch.rate_per_min).not.toBeNull();
    expect(paused.dispatch.eta_ms).toBeNull();
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
