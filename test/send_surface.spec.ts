import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BOUNCE_SPIKE_RECENT_MS,
  type SendFeedResponse,
  type SendListResponse,
  type SendSummary,
  type SendView,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox } from "../src/providers/fake";
import { sendActions, sendConditions } from "../src/send/conditions";
import { freeze } from "../src/send/schedule";
import { adminAuth } from "./support/auth";
import { has } from "./support/conditions";

// The API-first send surface (SPEC §8, §12): conditions and actions derived once by the
// server and carried by every route, a distinct code per refusal carrying the send as it
// stands, actions safe to retry, `If-Match`, the review window closing at the fire time,
// and query values refused rather than dropped.

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

async function frozenSend(fireAt: number, subject = "Subj") {
  const { post } = await posts.createPost(env.DB, { subject, markdown: "# Hi\n\nbody" }, "test");
  return freeze(env, getConfig(env), post, fireAt);
}

async function setRow(id: string, fields: Record<string, number | string | null>): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c] ?? null), id)
    .run();
}

async function progress(id: string): Promise<SendView> {
  return (await readJson(await SELF.fetch(`${base}/sends/${id}`, { headers: AUTH }))).send;
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...(body === undefined ? AUTH : JSON_AUTH), ...headers },
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

/** A send row as the list reads it, for the pure rules. */
function row(over: Partial<SendSummary>): SendSummary {
  return {
    id: "s1",
    post_id: "p1",
    status: "sending",
    fire_at: 0,
    subject: "Subj",
    recipient_count: 100,
    locked_until: null,
    scheduled_at: 0,
    started_at: null,
    completed_at: null,
    audience_resolved_at: null,
    remade_at: null,
    tested_at: null,
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
    rev: 1,
    ...over,
  };
}

describe("conditions: one server rule for each kind", () => {
  const NOW = 1_800_000_000_000;
  const kinds = (s: SendSummary) => sendConditions(s, NOW).map((c) => c.kind);

  it("reads missed only past the tolerance, and remade only while the last test predates the re-make", () => {
    const sched = { status: "scheduled" as const, fire_at: NOW - 60_000 };
    expect(kinds(row(sched))).toEqual([]);
    const missed = sendConditions(row({ ...sched, fire_at: NOW - MISSED_THRESHOLD_MS - 1 }), NOW);
    expect(missed.map((c) => [c.kind, c.severity, c.action])).toEqual([["missed", "action", null]]);
    const remade = { status: "scheduled" as const, fire_at: NOW + 60_000, remade_at: NOW - 10 };
    expect(kinds(row(remade))).toEqual(["remade"]);
    expect(kinds(row({ ...remade, tested_at: NOW - 20 }))).toEqual(["remade"]);
    expect(kinds(row({ ...remade, tested_at: NOW - 5 }))).toEqual([]);
  });

  it("reads wedged with its count and the Resolve action, refused with the fix and no action, and stuck", () => {
    const wedged = sendConditions(row({ c_in_flight: 3, started_at: NOW - 60_000 }), NOW);
    expect(wedged).toEqual([
      expect.objectContaining({
        kind: "wedged",
        severity: "action",
        count: 3,
        action: { name: "resolve", method: "POST", path: "/sends/s1/resolve" },
      }),
    ]);
    const refused = sendConditions(
      row({
        c_pending: 5,
        started_at: NOW - STUCK_THRESHOLD_MS - 60_000,
        halt_reason: "account",
        halt_cause: "quota",
        halt_error: "Daily message quota exceeded",
        halted_at: NOW - 60_000,
        halt_retry_at: NOW + 60_000,
      }),
      NOW,
    );
    expect(refused.map((c) => c.kind)).toEqual(["refused", "stuck"]); // most severe first
    expect(refused[0]).toMatchObject({
      action: null,
      cause: "quota",
      error: "Daily message quota exceeded",
      advice: "Wait for the provider's sending quota to reset, or raise it on your plan.",
      retry_at: NOW + 60_000,
      since: NOW - 60_000,
    });
    expect(refused[0]?.message).toMatch(
      /^The provider is refusing the account: Daily message quota exceeded\. Wait/,
    );
    const outage = sendConditions(
      row({ c_pending: 5, halt_reason: "unavailable", halt_error: "503", halt_retry_at: NOW + 1 }),
      NOW,
    );
    expect(outage.map((c) => [c.kind, c.severity])).toEqual([["provider_unavailable", "info"]]);
  });

  it("reads a bounce spike off a recently sent send at the danger zone, and never off an old or small one", () => {
    const sent = { status: "sent" as const, completed_at: NOW - 60_000, recipient_count: 100 };
    expect(kinds(row({ ...sent, c_bounced: 5 }))).toEqual(["bounce_spike"]);
    expect(kinds(row({ ...sent, c_bounced: 4 }))).toEqual([]); // 4%: under the rate
    expect(kinds(row({ ...sent, recipient_count: 20, c_bounced: 2 }))).toEqual([]); // under the floor
    expect(
      kinds(row({ ...sent, completed_at: NOW - BOUNCE_SPIKE_RECENT_MS - 1, c_bounced: 50 })),
    ).toEqual([]);
    expect(sendConditions(row({ ...sent, c_bounced: 5 }), NOW)[0]).toMatchObject({
      severity: "warn",
      bounced: 5,
      rate: 0.05,
    });
  });

  it("reports no halt on a wedged send, which nothing will retry", () => {
    const wedged = row({
      c_in_flight: 1,
      halt_reason: "account",
      halt_cause: "quota",
      halt_error: "quota exceeded",
      halt_retry_at: NOW - 60_000,
    });
    expect(kinds(wedged)).toEqual(["wedged"]);
  });

  it("offers cancel and reschedule only inside the window, and Resolve only while wedged", () => {
    const names = (s: SendSummary) => sendActions(s, NOW).map((a) => a.name);
    expect(names(row({ status: "scheduled", fire_at: NOW + 1 }))).toEqual(["cancel", "reschedule"]);
    expect(names(row({ status: "scheduled", fire_at: NOW }))).toEqual([]); // due: the window has closed
    expect(names(row({ c_in_flight: 2 }))).toEqual(["resolve"]);
    expect(names(row({ c_in_flight: 2, locked_until: NOW + 1 }))).toEqual([]); // a run holds it
    expect(names(row({ status: "sent" }))).toEqual([]);
  });
});

describe("every route reads a send the same way", () => {
  it("carries the same conditions and actions on the list, the send, its progress, and the feed, and rolls every open condition into each feed read", async () => {
    const now = Date.now();
    const wedged = await frozenSend(now - 120_000, "Wedged");
    await setRow(wedged.id, {
      status: "sending",
      started_at: now - 100_000,
      audience_resolved_at: now - 100_000,
      c_in_flight: 2,
      c_accepted: 8,
    });
    const upcoming = await frozenSend(now + 3_600_000, "Upcoming");
    const list = (await readJson(
      await SELF.fetch(`${base}/sends`, { headers: AUTH }),
    )) as SendListResponse;
    const detail = await readJson(
      await SELF.fetch(`${base}/sends/${wedged.id}`, { headers: AUTH }),
    );
    const prog = await progress(wedged.id);
    const listed = list.sends.find((s) => s.id === wedged.id);
    expect(listed?.conditions).toEqual(prog.conditions);
    expect(detail.send.conditions).toEqual(prog.conditions);
    expect(listed?.actions).toEqual([
      { name: "resolve", method: "POST", path: `/sends/${wedged.id}/resolve` },
    ]);
    expect(list.sends.find((s) => s.id === upcoming.id)?.actions.map((a) => a.name)).toEqual([
      "cancel",
      "reschedule",
    ]);
    // A feed read from now reports no send (nothing changed), but still every open problem.
    const feed = (await readJson(
      await SELF.fetch(`${base}/sends/feed?since=${encodeURIComponent(list.cursor)}`, {
        headers: AUTH,
      }),
    )) as SendFeedResponse;
    expect(feed.sends).toEqual([]);
    expect(feed.conditions.map((c) => [c.send_id, c.subject, c.kind])).toEqual([
      [wedged.id, "Wedged", "wedged"],
    ]);
  });

  it("clears remade once the scheduled send's frozen copy is tested", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, "Re-made");
    await setRow(send.id, { remade_at: Date.now() - 1000 });
    expect(has(await progress(send.id), "remade")).toBe(true);
    const test = await post(`/posts/${send.post_id}/test`, { to: "me@example.com" });
    expect(test.status).toBe(200);
    expect((await readJson(test)).frozen).toBe(true);
    expect((await sends.getSend(env.DB, send.id))?.tested_at).not.toBeNull();
    expect(has(await progress(send.id), "remade")).toBe(false);
  });
});

describe("a test racing a re-make", () => {
  it("does not mark the re-made copy tested when the test read the copy before the re-make", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, "Raced");
    const readAt = Date.now();
    await setRow(send.id, { remade_at: readAt + 5 }); // the re-make lands while the test is out
    await sends.markTested(env.DB, send.id, readAt, readAt + 10);
    expect((await sends.getSend(env.DB, send.id))?.tested_at).toBeNull();
    expect(has(await progress(send.id), "remade")).toBe(true);
    // A test that read the re-made copy does settle it.
    await sends.markTested(env.DB, send.id, readAt + 6, readAt + 20);
    expect(has(await progress(send.id), "remade")).toBe(false);
  });
});

describe("the review window closes at the fire time", () => {
  it("refuses cancel and reschedule once the send is due, before the sweep starts it, with window_closed and the send", async () => {
    const send = await frozenSend(Date.now() - 5_000, "Due");
    for (const [path, body] of [
      [`/sends/${send.id}/cancel`, undefined],
      [`/sends/${send.id}/reschedule`, { fire_at: Date.now() + 3_600_000 }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(409);
      const err = await readJson(res);
      expect(err).toMatchObject({ error: "window_closed", send: { id: send.id, phase: "due" } });
      expect(err.send.actions).toEqual([]);
      expect(err.send.rendered_html).toBeUndefined();
    }
    expect((await sends.getSend(env.DB, send.id))?.status).toBe("scheduled");
  });
});

describe("actions safe to retry, and If-Match", () => {
  it("answers a second cancel, and a move to the time the send already has, with 200 and changed false", async () => {
    const fireAt = Date.now() + 3_600_000;
    const send = await frozenSend(fireAt);
    const same = await post(`/sends/${send.id}/reschedule`, { fire_at: fireAt });
    expect(same.status).toBe(200);
    expect(await readJson(same)).toMatchObject({ changed: false, send: { fire_at: fireAt } });
    const before = (await sends.getSend(env.DB, send.id))?.rev;
    const first = await post(`/sends/${send.id}/cancel`);
    expect(await readJson(first)).toMatchObject({ changed: true, send: { status: "canceled" } });
    const again = await post(`/sends/${send.id}/cancel`);
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ changed: false, send: { status: "canceled" } });
    expect((await sends.getSend(env.DB, send.id))?.rev).toBeGreaterThan(before ?? 0);
    // A canceled send is not moved: it is scheduled again instead.
    const moved = await post(`/sends/${send.id}/reschedule`, { fire_at: fireAt + 60_000 });
    expect(await readJson(moved)).toMatchObject({ error: "send_canceled" });
  });

  it("refuses an action whose If-Match names a rev the send has moved past, with 412 and the send", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const rev = (await sends.getSend(env.DB, send.id))?.rev ?? 0;
    const moved = await post(
      `/sends/${send.id}/reschedule`,
      { fire_at: Date.now() + 7_200_000 },
      { "if-match": `"${rev}"` },
    );
    expect(moved.status).toBe(200);
    const stale = await post(`/sends/${send.id}/cancel`, undefined, { "if-match": `"${rev}"` });
    expect(stale.status).toBe(412);
    expect(await readJson(stale)).toMatchObject({
      error: "precondition_failed",
      send: { id: send.id, status: "scheduled" },
    });
    const bad = await post(`/sends/${send.id}/cancel`, undefined, { "if-match": "yesterday" });
    expect(bad.status).toBe(400);
    expect(await readJson(bad)).toMatchObject({ field: "If-Match" });
  });
});

describe("a distinct code for each refusal", () => {
  it("names a post that is not a draft, one with an active send (carrying it), a missing subject, and a fire time too soon", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const again = await post(`/posts/${send.post_id}/schedule`, {
      fire_at: Date.now() + 7_200_000,
    });
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({
      error: "active_send_exists",
      send: { id: send.id, actions: [{ name: "cancel" }, { name: "reschedule" }] },
    });

    const { post: blank } = await posts.createPost(env.DB, { subject: " ", markdown: "x" }, "t");
    const noSubject = await post(`/posts/${blank.id}/schedule`, {
      fire_at: Date.now() + 3_600_000,
    });
    expect(await readJson(noSubject)).toMatchObject({
      error: "subject_required",
      field: "subject",
    });

    const { post: soon } = await posts.createPost(env.DB, { subject: "S", markdown: "x" }, "t");
    const tooSoon = await post(`/posts/${soon.id}/schedule`, { fire_at: Date.now() + 1000 });
    expect(tooSoon.status).toBe(400);
    expect(await readJson(tooSoon)).toMatchObject({ error: "fire_at_too_soon", field: "fire_at" });

    await setRow(send.id, { status: "sent", completed_at: Date.now() });
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(send.post_id).run();
    const sent = await post(`/posts/${send.post_id}/schedule`, { fire_at: Date.now() + 3_600_000 });
    expect(await readJson(sent)).toMatchObject({ error: "post_not_draft" });
  });
});

describe("query values are refused, never dropped", () => {
  it("400s an unknown status, failures, sort, dir, or a limit that is not a number, naming the field", async () => {
    for (const [q, field] of [
      ["status=pending", "status"],
      ["failures=yes", "failures"],
      ["sort=bogus", "sort"],
      ["dir=sideways", "dir"],
      ["limit=lots", "limit"],
      ["offset=first", "offset"],
    ]) {
      const res = await SELF.fetch(`${base}/sends?${q}`, { headers: AUTH });
      expect([q, res.status]).toEqual([q, 400]);
      expect(await readJson(res)).toMatchObject({ error: "bad_request", field });
    }
    // A number past the page size's maximum is still held to it, as documented.
    const big = await readJson(await SELF.fetch(`${base}/sends?limit=9999`, { headers: AUTH }));
    expect(big.page.limit).toBe(200);
  });
});
