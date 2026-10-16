import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { writesDay } from "../shared/daily_writes";
import {
  BOUNCE_SPIKE_RECENT_MS,
  DAILY_WRITES_SEND_RECIPIENTS,
  NO_RECEIPTS_AFTER_MS,
  refusalAdvice,
  SELF_THROTTLE_HALTS,
  type SendFeedResponse,
  type SendListResponse,
  type SendSummary,
  type SendView,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { DEFAULT_SUBREQUEST_BUDGET } from "../src/env";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox } from "../src/providers/fake";
import { sendActions, sendConditions } from "../src/send/conditions";
import { readWritesDay } from "../src/send/describe";
import { onTheMinute } from "../src/send/schedule";
import { has } from "./support/conditions";
import { guardD1 } from "./support/d1_guard";
import { frozenSend, resetDatabase, setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

// The API-first send surface (SPEC §8, §12): conditions and actions derived once by the
// server and carried by every route, a distinct code per refusal carrying the send as it
// stands, actions safe to retry and carrying no precondition, the review window closing at
// the fire time, and query values refused rather than dropped.

/** A send's view, as `GET /api/sends/:id` answers it. */
async function readView(id: string): Promise<SendView> {
  return (await readJson(await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH }))).send;
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...(body === undefined ? AUTH : JSON_AUTH), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  await resetDatabase();
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
    progress_at: null,
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
  const kinds = (s: SendSummary) => sendConditions(s, NOW, null).map((c) => c.kind);

  it("reads missed only past the tolerance, and remade only while the last test predates the re-make", () => {
    const sched = { status: "scheduled" as const, fire_at: NOW - 60_000, tested_at: NOW - 90_000 };
    expect(kinds(row(sched))).toEqual([]);
    const missed = sendConditions(
      row({ ...sched, fire_at: NOW - MISSED_THRESHOLD_MS - 1 }),
      NOW,
      null,
    );
    expect(missed.map((c) => [c.kind, c.severity, c.action])).toEqual([["missed", "action", null]]);
    const remade = { status: "scheduled" as const, fire_at: NOW + 60_000, remade_at: NOW - 10 };
    expect(kinds(row(remade))).toEqual(["remade"]);
    // The editor shows this message as is, so its wording is pinned here, not only in the client's copy.
    expect(sendConditions(row(remade), NOW, null)[0]?.message).toBe(
      "The template or publication details changed this email’s look after your last test. Its content and send time are the same. Send a new test to check what will go out.",
    );
    expect(kinds(row({ ...remade, tested_at: NOW - 20 }))).toEqual(["remade"]);
    expect(kinds(row({ ...remade, tested_at: NOW - 5 }))).toEqual([]);
  });

  it("reads untested on a scheduled send never tested and never re-made, as info (SPEC §8)", () => {
    const sched = { status: "scheduled" as const, fire_at: NOW + 60_000, scheduled_at: NOW - 10 };
    expect(sendConditions(row(sched), NOW, null)).toEqual([
      {
        kind: "untested",
        severity: "info",
        since: NOW - 10,
        // The editor shows this message as is.
        message:
          "No test of this email has been sent yet. Send yourself a test to check what will go out.",
        action: null,
      },
    ]);
    expect(kinds(row({ ...sched, tested_at: NOW - 5 }))).toEqual([]);
    // Re-made and never tested is `remade`'s to say, not both.
    expect(kinds(row({ ...sched, remade_at: NOW - 5 }))).toEqual(["remade"]);
    // Only a scheduled send: one that went out untested is not flagged after the fact.
    expect(kinds(row({ ...sched, status: "sending", started_at: NOW - 5 }))).toEqual([]);
    expect(kinds(row({ ...sched, status: "canceled", completed_at: NOW - 5 }))).toEqual([]);
  });

  it("warns of D1's daily writes only on Free's limits, past the threshold, while the send is scheduled (SPEC §8)", () => {
    const sched = {
      status: "scheduled" as const,
      fire_at: NOW + 60_000,
      scheduled_at: NOW - 10,
      tested_at: NOW - 5,
      recipient_count: DAILY_WRITES_SEND_RECIPIENTS + 1,
    };
    const free = (s: SendSummary) => sendConditions(s, NOW, writesDay(NOW, 0));
    expect(free(row(sched))).toEqual([
      {
        kind: "daily_writes",
        severity: "warn",
        since: NOW - 10,
        message:
          "On the Workers Free plan’s limits, a send to 5,001 recipients may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Workers Paid is recommended for a list of more than 5,000.",
        action: null,
        recipients: DAILY_WRITES_SEND_RECIPIENTS + 1,
      },
    ]);
    expect(free(row({ ...sched, recipient_count: DAILY_WRITES_SEND_RECIPIENTS }))).toEqual([]);
    expect(sendConditions(row(sched), NOW, null)).toEqual([]);
    expect(free(row({ ...sched, status: "sending", started_at: NOW - 60_000 }))).toEqual([]);
  });

  it("counts what imports wrote on the UTC day the send fires, and nothing a later day's send (SPEC §8)", () => {
    const day = writesDay(NOW, 30_000); // 30,000 rows written by imports so far today
    const sched = {
      status: "scheduled" as const,
      fire_at: NOW + 60_000,
      scheduled_at: NOW - 10,
      tested_at: NOW - 5,
      recipient_count: 3_000, // 42,000 rows: over the budget only beside the imports
    };
    expect(sendConditions(row(sched), NOW, day)).toEqual([
      {
        kind: "daily_writes",
        severity: "warn",
        since: NOW - 10,
        message:
          "On the Workers Free plan’s limits, a send to 3,000 recipients on the same day as today’s imports may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Send it tomorrow (UTC), or move to Workers Paid, which is recommended for a list of more than 5,000.",
        action: null,
        recipients: 3_000,
      },
    ]);
    expect(sendConditions(row({ ...sched, recipient_count: 2_800 }), NOW, day)).toEqual([]);
    expect(sendConditions(row({ ...sched, fire_at: day.until }), NOW, day)).toEqual([]);
    expect(sendConditions(row({ ...sched, fire_at: day.until - 1 }), NOW, day)).toHaveLength(1);
    // A send too large on its own says so in the words that don't blame the imports.
    const alone = sendConditions(row({ ...sched, recipient_count: 5_001 }), NOW, day);
    expect(alone[0]?.message).toMatch(
      /^On the Workers Free plan’s limits, a send to 5,001 recipients may use up/,
    );
  });

  it("reads the day's imports only for a send they can change, so most reads on Free read nothing for them", async () => {
    const config = { subrequestBudget: DEFAULT_SUBREQUEST_BUDGET };
    const now = Date.now();
    const until = writesDay(now, 0).until;
    const meter = guardD1(env.DB);
    const quiet = [
      { status: "scheduled" as const, fire_at: until, recipient_count: 10 }, // a later day
      { status: "scheduled" as const, fire_at: now + 60_000, recipient_count: 6_000 }, // over alone
      { status: "sent" as const, fire_at: now - 60_000, recipient_count: 10 },
    ];
    expect(await readWritesDay(meter.db, config, now, quiet)).toEqual(writesDay(now, 0));
    expect(meter.statements).toBe(0);
    await readWritesDay(meter.db, config, now, [
      { status: "scheduled", fire_at: until - 1, recipient_count: 10 },
    ]);
    expect(meter.statements).toBe(1);
    expect(await readWritesDay(meter.db, { subrequestBudget: 1000 }, now, quiet)).toBe(null);
  });

  it("reads wedged with its count and the Resolve action, refused with the fix and no action, and stuck only when nothing explains the wait", () => {
    const wedged = sendConditions(row({ c_in_flight: 3, started_at: NOW - 60_000 }), NOW, null);
    expect(wedged).toEqual([
      expect.objectContaining({
        kind: "wedged",
        severity: "action",
        count: 3,
        action: { name: "resolve", method: "POST", path: "/api/sends/s1/resolve" },
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
      null,
    );
    // Started long ago, but the refusal explains the wait until its retry: not also stuck.
    expect(refused.map((c) => c.kind)).toEqual(["refused"]);
    expect(refused[0]).toMatchObject({
      action: null,
      cause: "quota",
      error: "Daily message quota exceeded",
      advice: refusalAdvice("quota"),
      retry_at: NOW + 60_000,
      since: NOW - 60_000,
    });
    expect(refused[0]?.message).toMatch(
      /^The provider is refusing the account: Daily message quota exceeded\. SES’s 24-hour quota/,
    );
    const outage = sendConditions(
      row({ c_pending: 5, halt_reason: "unavailable", halt_error: "503", halt_retry_at: NOW + 1 }),
      NOW,
      null,
    );
    expect(outage.map((c) => [c.kind, c.severity])).toEqual([["provider_unavailable", "info"]]);
    // Nothing handed off for the threshold and no halt to explain it (SPEC §12).
    const idle = sendConditions(
      row({
        c_pending: 5,
        started_at: NOW - 3 * STUCK_THRESHOLD_MS,
        progress_at: NOW - STUCK_THRESHOLD_MS - 60_000,
      }),
      NOW,
      null,
    );
    expect(idle.map((c) => [c.kind, c.severity])).toEqual([["stuck", "warn"]]);
    expect(idle[0]).toMatchObject({ since: NOW - 60_000, action: null });
    expect(idle[0]?.message).toMatch(
      /^Nothing has gone out for 31 minutes, with no retry or provider problem to explain it\./,
    );
  });

  it("tells a rate limit that outlasts any burst apart, naming SES_MAX_SEND_RATE (SPEC §12)", () => {
    const throttled = (halt_retries: number) =>
      sendConditions(
        row({
          c_pending: 5,
          halt_reason: "unavailable",
          halt_cause: "rate_limit",
          halt_error: "ses 429 TooManyRequestsException: Maximum sending rate exceeded.",
          halt_retries,
          halted_at: NOW - 60_000,
          halt_retry_at: NOW + 60_000,
        }),
        NOW,
        null,
      );
    const burst = throttled(SELF_THROTTLE_HALTS - 1);
    expect(burst.map((c) => [c.kind, c.severity])).toEqual([["provider_unavailable", "info"]]);
    expect(burst[0]?.message).not.toContain("SES_MAX_SEND_RATE");
    const setting = throttled(SELF_THROTTLE_HALTS);
    expect(setting.map((c) => [c.kind, c.severity])).toEqual([["provider_unavailable", "warn"]]);
    expect(setting[0]?.message).toContain("Whoever runs the deployment sets SES_MAX_SEND_RATE");
  });

  it("says this send, not the account, when the provider refuses its email, and holds no one unsent because of it", () => {
    const [refused] = sendConditions(
      row({
        c_pending: 5,
        c_unsent: 2,
        halt_reason: "account",
        halt_cause: "content",
        halt_error: "ses 400 MessageRejected: no",
        halted_at: NOW - 60_000,
        halt_retry_at: NOW + 60_000,
      }),
      NOW,
      null,
    );
    expect(refused).toMatchObject({ kind: "refused", cause: "content" });
    expect(refused?.message).toMatch(
      /^The provider is refusing this send: ses 400 MessageRejected: no\. /,
    );
    expect(refused?.message).toContain("No one has been marked unsent because of this");
  });

  it("reads a bounce spike off a recently sent send at the danger zone, and never off an old or small one", () => {
    const sent = { status: "sent" as const, completed_at: NOW - 60_000, recipient_count: 100 };
    expect(kinds(row({ ...sent, c_bounced: 5 }))).toEqual(["bounce_spike"]);
    expect(kinds(row({ ...sent, c_bounced: 4 }))).toEqual([]); // 4%: under the rate
    expect(kinds(row({ ...sent, recipient_count: 20, c_bounced: 2 }))).toEqual([]); // under the floor
    expect(
      kinds(row({ ...sent, completed_at: NOW - BOUNCE_SPIKE_RECENT_MS - 1, c_bounced: 50 })),
    ).toEqual([]);
    expect(sendConditions(row({ ...sent, c_bounced: 5 }), NOW, null)[0]).toMatchObject({
      severity: "warn",
      bounced: 5,
      rate: 0.05,
    });
  });

  it("says a recently sent send with no receipt at all, long after dispatch, may not be hearing from the provider (SPEC §8)", () => {
    const sent = {
      status: "sent" as const,
      completed_at: NOW - NO_RECEIPTS_AFTER_MS - 60_000,
      c_accepted: 40,
    };
    const silent = sendConditions(row(sent), NOW, null);
    expect(silent.map((c) => [c.kind, c.severity])).toEqual([["no_receipts", "warn"]]);
    expect(silent[0]).toMatchObject({
      since: NOW - 60_000,
      action: null,
      accepted: 40,
    });
    expect(silent[0]?.message).toMatch(
      /^No delivery receipt has arrived for any of the 40 recipients the provider took, 1 hour after/,
    );
    // Settling as usual: too soon to say, or any receipt at all has come.
    expect(kinds(row({ ...sent, completed_at: NOW - NO_RECEIPTS_AFTER_MS + 60_000 }))).toEqual([]);
    expect(kinds(row({ ...sent, c_accepted: 39, c_delivered: 1 }))).toEqual([]);
    expect(kinds(row({ ...sent, c_accepted: 39, c_bounced: 1 }))).toEqual([]);
    expect(kinds(row({ ...sent, c_accepted: 39, c_complained: 1 }))).toEqual([]);
    // Nothing waits on a receipt, or the send is history past the recent window.
    expect(kinds(row({ ...sent, c_accepted: 0, c_unsent: 40 }))).toEqual([]);
    expect(kinds(row({ ...sent, completed_at: NOW - BOUNCE_SPIKE_RECENT_MS - 1 }))).toEqual([]);
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
  it("carries the same conditions and actions on the list, the send, and the feed, and rolls every open condition into each feed read", async () => {
    const readList = async () =>
      (await readJson(
        await SELF.fetch(`${base}/api/sends`, { headers: AUTH }),
      )) as SendListResponse;
    const readFeed = async (since: string) =>
      (await readJson(
        await SELF.fetch(`${base}/api/sends/feed?since=${encodeURIComponent(since)}`, {
          headers: AUTH,
        }),
      )) as SendFeedResponse;
    // A cursor from before either send was made, so the feed reports both as changes.
    const empty = (await readList()).cursor;
    const now = Date.now();
    const wedged = await frozenSend(now - 120_000, { subject: "Wedged" });
    await setRow(wedged.id, {
      status: "sending",
      started_at: now - 100_000,
      audience_resolved_at: now - 100_000,
      c_in_flight: 2,
      c_accepted: 8,
    });
    const upcoming = await frozenSend(now + 3_600_000, { subject: "Upcoming" });
    const list = await readList();
    const reported = await readFeed(empty);
    for (const send of [wedged, upcoming]) {
      const one = await readView(send.id);
      const listed = list.sends.find((s) => s.id === send.id);
      const fed = reported.sends.find((s) => s.id === send.id);
      expect([listed?.conditions, listed?.actions]).toEqual([one.conditions, one.actions]);
      expect([fed?.conditions, fed?.actions]).toEqual([one.conditions, one.actions]);
    }
    expect((await readView(wedged.id)).conditions.map((c) => c.kind)).toEqual(["wedged"]);
    expect(list.sends.find((s) => s.id === wedged.id)?.actions).toEqual([
      { name: "resolve", method: "POST", path: `/api/sends/${wedged.id}/resolve` },
    ]);
    expect(list.sends.find((s) => s.id === upcoming.id)?.actions.map((a) => a.name)).toEqual([
      "cancel",
      "reschedule",
    ]);
    // A feed read from now reports no send (nothing changed), but still every open problem.
    const feed = await readFeed(list.cursor);
    expect(feed.sends).toEqual([]);
    expect(feed.conditions.map((c) => [c.send_id, c.subject, c.kind])).toEqual([
      [wedged.id, "Wedged", "wedged"],
      [upcoming.id, "Upcoming", "untested"],
    ]);
  });

  it("clears remade once the scheduled send's frozen copy is tested", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, { subject: "Re-made" });
    await setRow(send.id, { remade_at: Date.now() - 1000 });
    expect(has(await readView(send.id), "remade")).toBe(true);
    const test = await post(`/api/posts/${send.post_id}/test`, { to: "me@example.com" });
    expect(test.status).toBe(200);
    expect((await readJson(test)).frozen).toBe(true);
    expect((await sends.getSend(env.DB, send.id))?.tested_at).not.toBeNull();
    expect(has(await readView(send.id), "remade")).toBe(false);
  });
});

describe("a send never tested", () => {
  it("carries untested until a test of the frozen copy lands, on the send and in the feed (SPEC §8)", async () => {
    const readFeed = async (): Promise<SendFeedResponse> =>
      readJson(await SELF.fetch(`${base}/api/sends/feed`, { headers: AUTH }));
    const send = await frozenSend(Date.now() + 3_600_000, { subject: "Untested" });
    expect(has(await readView(send.id), "untested")).toBe(true);
    const fed = await readFeed();
    expect(fed.conditions.map((c) => [c.send_id, c.kind])).toEqual([[send.id, "untested"]]);
    const test = await post(`/api/posts/${send.post_id}/test`, { to: "me@example.com" });
    expect(test.status).toBe(200);
    expect(has(await readView(send.id), "untested")).toBe(false);
    expect((await readFeed()).conditions).toEqual([]);
  });
});

describe("a test racing a re-make", () => {
  it("does not mark the re-made copy tested when the test read the copy before the re-make", async () => {
    const send = await frozenSend(Date.now() + 3_600_000, { subject: "Raced" });
    const readAt = Date.now();
    await setRow(send.id, { remade_at: readAt + 5 }); // the re-make lands while the test is out
    await sends.markTested(env.DB, send.id, readAt, readAt + 10);
    expect((await sends.getSend(env.DB, send.id))?.tested_at).toBeNull();
    expect(has(await readView(send.id), "remade")).toBe(true);
    // A test that read the re-made copy does settle it.
    await sends.markTested(env.DB, send.id, readAt + 6, readAt + 20);
    expect(has(await readView(send.id), "remade")).toBe(false);
  });
});

describe("the review window closes at the fire time", () => {
  it("refuses cancel and reschedule once the send is due, before the sweep starts it, with window_closed and the send", async () => {
    const send = await frozenSend(Date.now() - 5_000, { subject: "Due" });
    for (const [path, body] of [
      [`/api/sends/${send.id}/cancel`, undefined],
      [`/api/sends/${send.id}/reschedule`, { fire_at: Date.now() + 3_600_000 }],
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

describe("actions safe to retry, with no precondition", () => {
  it("answers a second cancel, and a move to the time the send already has, with 200 and changed false", async () => {
    const fireAt = onTheMinute(Date.now() + 3_600_000);
    const send = await frozenSend(fireAt);
    // A no-op takes no number: a rev stamped on it would report a change the feed's
    // followers never saw happen.
    const rev = async () => (await sends.getSend(env.DB, send.id))?.rev;
    const scheduled = await rev();
    const same = await post(`/api/sends/${send.id}/reschedule`, { fire_at: fireAt });
    expect(same.status).toBe(200);
    expect(await readJson(same)).toMatchObject({
      changed: false,
      send: { fire_at: fireAt, rev: scheduled },
    });
    // The same minute with seconds on it is the same time as stored: still no change.
    const seconds = await post(`/api/sends/${send.id}/reschedule`, { fire_at: fireAt - 25_000 });
    expect(await readJson(seconds)).toMatchObject({ changed: false, send: { fire_at: fireAt } });
    expect(await rev()).toBe(scheduled);
    const first = await post(`/api/sends/${send.id}/cancel`);
    expect(await readJson(first)).toMatchObject({ changed: true, send: { status: "canceled" } });
    const canceled = await rev();
    expect(canceled).toBeGreaterThan(scheduled ?? 0);
    const again = await post(`/api/sends/${send.id}/cancel`);
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({
      changed: false,
      send: { status: "canceled", rev: canceled },
    });
    expect(await rev()).toBe(canceled);
    // A canceled send is not moved: it is scheduled again instead.
    const moved = await post(`/api/sends/${send.id}/reschedule`, { fire_at: fireAt + 60_000 });
    expect(await readJson(moved)).toMatchObject({ error: "send_canceled" });
  });

  it("applies an action to the send as it stands, ignoring an If-Match", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const rev = (await sends.getSend(env.DB, send.id))?.rev ?? 0;
    const moved = await post(
      `/api/sends/${send.id}/reschedule`,
      { fire_at: Date.now() + 7_200_000 },
      { "if-match": "yesterday" },
    );
    expect(moved.status).toBe(200);
    // The rev the caller read is behind the send now; the cancel lands all the same.
    const canceled = await post(`/api/sends/${send.id}/cancel`, undefined, {
      "if-match": `"${rev}"`,
    });
    expect(canceled.status).toBe(200);
    expect(await readJson(canceled)).toMatchObject({
      changed: true,
      send: { id: send.id, status: "canceled" },
    });
  });
});

describe("a distinct code for each refusal", () => {
  it("names a post that is not a draft, one with an active send (carrying it), a missing subject, and a fire time too soon", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    const again = await post(`/api/posts/${send.post_id}/schedule`, {
      fire_at: Date.now() + 7_200_000,
    });
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({
      error: "active_send_exists",
      send: { id: send.id, actions: [{ name: "cancel" }, { name: "reschedule" }] },
    });

    const { post: blank } = await posts.createPost(env.DB, { subject: " ", markdown: "x" }, "t");
    const noSubject = await post(`/api/posts/${blank.id}/schedule`, {
      fire_at: Date.now() + 3_600_000,
    });
    expect(await readJson(noSubject)).toMatchObject({
      error: "subject_required",
      field: "subject",
    });

    const { post: soon } = await posts.createPost(env.DB, { subject: "S", markdown: "x" }, "t");
    const tooSoon = await post(`/api/posts/${soon.id}/schedule`, { fire_at: Date.now() + 1000 });
    expect(tooSoon.status).toBe(400);
    expect(await readJson(tooSoon)).toMatchObject({ error: "fire_at_too_soon", field: "fire_at" });

    await setRow(send.id, { status: "sent", completed_at: Date.now() });
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(send.post_id).run();
    const sent = await post(`/api/posts/${send.post_id}/schedule`, {
      fire_at: Date.now() + 3_600_000,
    });
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
      const res = await SELF.fetch(`${base}/api/sends?${q}`, { headers: AUTH });
      expect([q, res.status]).toEqual([q, 400]);
      expect(await readJson(res)).toMatchObject({ error: "bad_request", field });
    }
    // A number past the page size's maximum is still held to it, as documented.
    const big = await readJson(await SELF.fetch(`${base}/api/sends?limit=9999`, { headers: AUTH }));
    expect(big.page.limit).toBe(200);
  });
});
