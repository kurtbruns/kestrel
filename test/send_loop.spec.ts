import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { readSettings, updateSettings } from "../src/db/settings";
import * as subscribersDb from "../src/db/subscribers";
import { getConfig } from "../src/env";
import { LEASE_TTL_MS, MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";
import { frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { allowErrorLogs, logged } from "./support/log";

const config = () => getConfig(env);

const countTo = (email: string) => fakeOutbox().filter((m) => m.to === email).length;

// The sweep is global over all sends, so each test needs a clean slate (storage
// is not rolled back between tests in a file).
beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the freeze reads the template it froze with", () => {
  it("the insert lands only while the settings row is still at the version the render used", async () => {
    // The guard closes one direction of a schedule racing a template save: a freeze
    // that rendered with settings the publisher has since replaced must not land as a
    // scheduled send on the older look (SPEC §6, §9). Exercised at the statement level
    // so the order is deterministic: a stale version inserts nothing, the current one
    // inserts the row.
    const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "hi" }, "test");
    await updateSettings(env.DB, { publication: { tagline: "v1" } });
    const { version } = await readSettings(env.DB);
    const row = {
      id: "s-guard",
      post_id: post.id,
      fire_at: Date.now() + 600_000,
      recipient_count: 0,
      rendered_html: "<p>x</p>",
      rendered_text: "x",
      subject: "Subj",
    };
    const stale = await sends
      .insertScheduledSendStmt(env.DB, row, Date.now(), (version ?? 0) - 1)
      .run();
    expect(stale.meta.changes ?? 0).toBe(0);
    expect(await sends.getSend(env.DB, "s-guard")).toBeNull();

    const fresh = await sends.insertScheduledSendStmt(env.DB, row, Date.now(), version ?? 0).run();
    expect(fresh.meta.changes ?? 0).toBe(1);
    expect((await sends.getSend(env.DB, "s-guard"))?.status).toBe("scheduled");
  });

  it("freeze() re-renders when the settings move under it, and still lands one scheduled send", async () => {
    // A settings write that lands between a freeze's read and its insert makes the
    // guarded insert change zero rows; the freeze then reads again and renders with
    // the new settings. Simulated by bumping the row's version from a hook on the
    // first render: the send that lands carries the tagline saved in the gap.
    await updateSettings(env.DB, { publication: { tagline: "before" } });
    const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "hi" }, "test");
    const tpl = `<div>{{ .Post.Body }} <i>{{ .Publication.Tagline }}</i> <a href="{{ .Email.UnsubscribeURL }}">u</a></div>`;
    await updateSettings(env.DB, { emailTemplate: tpl });
    let bumped = false;
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      // Runs after the render and before the insert, once: the "concurrent" save.
      if (!bumped) {
        bumped = true;
        await updateSettings(db, { publication: { tagline: "after" } });
      }
      return 0;
    });
    const send = await freeze(env, config(), post, Date.now() + 600_000);
    expect(send.status).toBe("scheduled");
    expect(send.rendered_html).toContain("after");
    expect(send.rendered_html).not.toContain("before");
    expect((await posts.getPost(env.DB, post.id))!.status).toBe("scheduled");
  });
});

describe("send loop + sweep", () => {
  it("delivers a due send to the whole audience and completes (I1)", async () => {
    await seedConfirmed(["a@example.com", "b@example.com", "c@example.com"]);
    // Everyone else on the list, none of whom the audience may reach (I1): a reader who
    // never confirmed, one who left, and a confirmed reader whose address is suppressed.
    await env.DB.prepare(
      `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES
         ('id-p', 'pending@example.com', 'pending', 'cfm-p', 'uns-p', ?1, NULL),
         ('id-u', 'left@example.com', 'unsubscribed', 'cfm-u', 'uns-u', ?1, ?1)`,
    )
      .bind(Date.now())
      .run();
    await seedConfirmed("bounced@example.com");
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES ('bounced@example.com', 'bounce', 'hard bounce', ?)",
    )
      .bind(Date.now())
      .run();
    const send = await frozenSend(Date.now() - 1000);
    expect(send.recipient_count).toBe(3);

    await sweep(env);

    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.recipient_count).toBe(3);
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("sent");
    // Only the audience has a delivery row at all: the rest were never part of the send.
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
    expect(
      fakeOutbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    // per-recipient unsubscribe link carries the subscriber's DURABLE unsub token
    // (not the one-shot confirm token), so it survives a later re-subscribe (I2).
    expect(fakeOutbox().every((m) => m.html.includes("/unsubscribe?token="))).toBe(true);
    const toA = fakeOutbox().find((m) => m.to === "a@example.com");
    expect(toA?.html).toContain("/unsubscribe?token=uns-a@example.com");
  });

  it("resumes after a mid-send crash and mails each recipient at most once (I4)", async () => {
    await seedConfirmed("x@example.com");
    await seedConfirmed("y@example.com");
    const send = await frozenSend(Date.now() - 1000);

    failFakeSendBatch(1); // the first request finds the provider down
    await sweep(env);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(fakeOutbox().length).toBe(0);
    expect(await sends.countDeliveries(env.DB, send.id, "pending")).toBe(2);

    // The failed request halted the run, so the send waits out its first backoff step.
    vi.useFakeTimers({ toFake: ["Date"] });
    await sweep(env);
    expect(fakeOutbox().length).toBe(0);
    await toNextTick(env.DB);
    await sweep(env); // resume
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 2 });
    expect(countTo("x@example.com")).toBe(1);
    expect(countTo("y@example.com")).toBe(1);
  });

  it("fixes the audience at the first run: a reader who confirms mid-send gets the next post (SPEC §6)", async () => {
    await seedConfirmed("x@example.com");
    await seedConfirmed("y@example.com");
    const send = await frozenSend(Date.now() - 1000);

    failFakeSendBatch(1); // the first run resolves the audience, then halts
    await sweep(env);
    const fired = (await sends.getSend(env.DB, send.id))!;
    expect(fired.status).toBe("sending");
    expect(fired.audience_resolved_at).not.toBeNull();
    expect(fired.recipient_count).toBe(2);

    await seedConfirmed("late@example.com"); // confirms while the send is in flight
    vi.useFakeTimers({ toFake: ["Date"] });
    await toNextTick(env.DB);
    await sweep(env); // resume
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.recipient_count).toBe(2);
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 2 });
    expect(countTo("late@example.com")).toBe(0);

    const next = await frozenSend(Date.now() - 1000);
    await sweep(env);
    expect((await sends.getSend(env.DB, next.id))!.status).toBe("sent");
    expect(countTo("late@example.com")).toBe(1);
    expect(countTo("x@example.com")).toBe(2);
  });

  it("a run that halts resumes without resolving the audience again", async () => {
    await seedConfirmed("x@example.com");
    await seedConfirmed("y@example.com");
    const send = await frozenSend(Date.now() - 1000);
    const spy = vi.spyOn(sends, "resolveAudience");
    failFakeSendBatch(1);
    await sweep(env);
    expect(spy).toHaveBeenCalledTimes(1);
    const resolvedAt = (await sends.getSend(env.DB, send.id))!.audience_resolved_at;

    vi.useFakeTimers({ toFake: ["Date"] });
    await toNextTick(env.DB);
    await sweep(env);
    expect(spy).toHaveBeenCalledTimes(1);
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.audience_resolved_at).toBe(resolvedAt);
  });

  it("resolveAudience inserts and marks in one guarded write, and never again", async () => {
    await seedConfirmed("a@example.com");
    const send = await frozenSend(Date.now() + 600_000);

    expect(await sends.resolveAudience(env.DB, send.id, Date.now())).toBe(true);
    await seedConfirmed("b@example.com");
    expect(await sends.resolveAudience(env.DB, send.id, Date.now())).toBe(false);

    const row = (await sends.getSend(env.DB, send.id))!;
    expect(row.recipient_count).toBe(1);
    expect(row.c_pending).toBe(1);
    expect(await sends.countDeliveries(env.DB, send.id, "pending")).toBe(1);
  });

  it("the scheduled snapshot counts the audience as it stood when it was taken", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    await seedConfirmed("bounced@example.com");
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at) VALUES ('id-p', 'pending@example.com', 'pending', 'cfm-p', 'uns-p', ?)",
    )
      .bind(Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES ('bounced@example.com', 'bounce', 'hard bounce', ?)",
    )
      .bind(Date.now())
      .run();

    const send = await frozenSend(Date.now() + 600_000);
    expect(send.recipient_count).toBe((await subscribersDb.audienceEmails(env.DB)).length);
    expect(send.recipient_count).toBe(2);
    expect(send.audience_resolved_at).toBeNull();

    // A snapshot, not a promise: a later confirm doesn't move it while scheduled.
    await seedConfirmed("c@example.com");
    expect((await sends.getSend(env.DB, send.id))!.recipient_count).toBe(2);
  });

  it("flags a missed fire time loudly but still delivers (§12)", async () => {
    allowErrorLogs("send.missed");
    const spy = vi.spyOn(console, "error");
    await seedConfirmed("late@example.com");
    const send = await frozenSend(Date.now() - (MISSED_THRESHOLD_MS + 60_000));

    await sweep(env);

    expect(logged(spy)).toContainEqual(
      expect.objectContaining({ event: "send.missed", level: "error", sendId: send.id }),
    );
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(countTo("late@example.com")).toBe(1);
  });

  it("a run that finds the lease held by another run mails no one (no double send)", async () => {
    await seedConfirmed(["o1@example.com", "o2@example.com"]);
    const send = await frozenSend(Date.now() - 1000);
    // Another run holds the lease, as one mid-send would.
    expect(await sends.acquireLease(env.DB, send.id, Date.now(), LEASE_TTL_MS)).not.toBeNull();

    const result = await runSend(env, send.id);

    expect(result.leased).toBe(false);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(fakeOutbox().length).toBe(0);
  });

  it("does not fire a scheduled send whose fire time is still in the future (reschedule-vs-sweep race, I6)", async () => {
    // The sweep snapshots due sends and then leases each one; a reschedule that moves a
    // just-due send forward lands in that gap, leaving the row `scheduled` at a new,
    // future fire_at. acquireLease re-checks fire_at (not just status), so runSend on a
    // not-yet-due scheduled send is a no-op — the send is never fired at its old time
    // after the API accepted the move. Without the guard this would lease, dispatch, and
    // mail the audience.
    await seedConfirmed("soon@example.com");
    const send = await frozenSend(Date.now() + 10 * 60 * 1000);

    const result = await runSend(env, send.id);

    expect(result.leased).toBe(false);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("scheduled");
    expect(fakeOutbox().length).toBe(0);
  });

  /** Fix a due send's audience with both readers, let `leave` act on `gone`, then sweep:
   *  the reader leaves after resolution and before any recipient is handed off. */
  async function leaveAfterResolution(leave: (email: string) => Promise<unknown>) {
    await seedConfirmed(["keep@example.com", "gone@example.com"]);
    const send = await frozenSend(Date.now() - 1000);
    await sends.resolveAudience(env.DB, send.id, Date.now());
    await leave("gone@example.com");

    await sweep(env);

    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.recipient_count).toBe(2); // both were in the audience it fixed
    expect(countTo("keep@example.com")).toBe(1);
    expect(countTo("gone@example.com")).toBe(0);
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 1, skipped: 1 });
  }

  it("skips a recipient who unsubscribed after audience resolution (I2)", async () => {
    await leaveAfterResolution((email) =>
      env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
        .bind(email)
        .run(),
    );
  });

  it("skips a recipient suppressed after audience resolution, at hand-off (SPEC §6, §10)", async () => {
    await leaveAfterResolution((email) =>
      env.DB.prepare(
        "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'complaint', 'marked as spam', ?)",
      )
        .bind(email, Date.now())
        .run(),
    );
  });
});
