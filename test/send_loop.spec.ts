import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { readSettings, updateSettings } from "../src/db/settings";
import * as subscribersDb from "../src/db/subscribers";
import { getConfig } from "../src/env";
import type { HttpError } from "../src/lib/errors";
import { LEASE_TTL_MS, MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { cancel, freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";
import { frozenSend, resetDatabase, seedConfirmed, sendAudience } from "./support/fixtures";
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
      warnings: [],
      from_name: "",
    };
    const stale = await sends
      .insertScheduledSendStmt(env.DB, row, Date.now(), sends.settingsVersionIs((version ?? 0) - 1))
      .run();
    expect(stale.meta.changes ?? 0).toBe(0);
    expect(await sends.getSend(env.DB, "s-guard")).toBeNull();

    const fresh = await sends
      .insertScheduledSendStmt(env.DB, row, Date.now(), sends.settingsVersionIs(version ?? 0))
      .run();
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
    await updateSettings(env.DB, { email_template: tpl });
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

describe("the freeze holds the post's revision at the lock (SPEC §6, I3)", () => {
  it("the insert lands only while the post is still on the revision the render used", async () => {
    // The other input a freeze reads: a save between its read and its write moves the post to a
    // new revision, and the write then inserts nothing. Exercised at the statement level so the
    // order is deterministic.
    const { post, revision } = await posts.createPost(
      env.DB,
      { subject: "Subj", markdown: "first" },
      "test",
    );
    const { version } = await readSettings(env.DB);
    const row = {
      id: "s-revision",
      post_id: post.id,
      fire_at: Date.now() + 600_000,
      recipient_count: 0,
      rendered_html: "<p>first</p>",
      rendered_text: "first",
      subject: "Subj",
      warnings: [],
      from_name: "",
    };
    const saved = await posts.updatePost(env.DB, post, { markdown: "second" }, "test");
    const stale = await sends
      .insertScheduledSendStmt(
        env.DB,
        row,
        Date.now(),
        sends.freezeGuard(version ?? 0, post.id, revision.id),
      )
      .run();
    expect(stale.meta.changes ?? 0).toBe(0);
    expect(await sends.getSend(env.DB, "s-revision")).toBeNull();

    const fresh = await sends
      .insertScheduledSendStmt(
        env.DB,
        row,
        Date.now(),
        sends.freezeGuard(version ?? 0, post.id, saved.revision.id),
      )
      .run();
    expect(fresh.meta.changes ?? 0).toBe(1);
  });

  it("freezes the post's latest content when it is handed a row a save has since moved on", async () => {
    // The schedule's route read the post, then a save landed before the freeze wrote: the send
    // holds the saved content, and the post and the send are on the same revision.
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Before", markdown: "first draft" },
      "test",
    );
    const saved = await posts.updatePost(
      env.DB,
      post,
      { subject: "After", markdown: "second draft" },
      "test",
    );

    const send = await freeze(env, config(), post, Date.now() + 600_000);

    expect(send.subject).toBe("After");
    expect(send.rendered_html).toContain("second draft");
    expect(send.rendered_html).not.toContain("first draft");
    const locked = (await posts.getPost(env.DB, post.id))!;
    expect([locked.status, locked.current_revision]).toEqual(["scheduled", saved.revision.id]);
  });

  it("freezes both the newer content and the newer settings when both move in one attempt", async () => {
    await updateSettings(env.DB, { publication: { tagline: "before" } });
    const tpl = `<div>{{ .Post.Body }} <i>{{ .Publication.Tagline }}</i> <a href="{{ .Email.UnsubscribeURL }}">u</a></div>`;
    await updateSettings(env.DB, { email_template: tpl });
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Subj", markdown: "first draft" },
      "test",
    );
    const saved = await posts.updatePost(env.DB, post, { markdown: "second draft" }, "test");
    let bumped = false;
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      // After the first render and before its write: a template save lands too.
      if (!bumped) {
        bumped = true;
        await updateSettings(db, { publication: { tagline: "after" } });
      }
      return 0;
    });

    const send = await freeze(env, config(), post, Date.now() + 600_000);

    expect(send.rendered_html).toContain("second draft");
    expect(send.rendered_html).toContain("after");
    expect(send.rendered_html).not.toContain("first draft");
    expect(send.rendered_html).not.toContain("before");
    const locked = (await posts.getPost(env.DB, post.id))!;
    expect([locked.status, locked.current_revision]).toEqual(["scheduled", saved.revision.id]);
  });

  it("refuses, freezing nothing and leaving the post a draft, when a save lands under every try", async () => {
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Subj", markdown: "draft 0" },
      "test",
    );
    let saves = 0;
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      // Between every render and its write, another writer saves the post.
      saves += 1;
      const current = (await posts.getPost(db, post.id))!;
      await posts.updatePost(db, current, { markdown: `draft ${saves}` }, "test");
      return 0;
    });

    const err = await freeze(env, config(), post, Date.now() + 600_000).catch((e: unknown) => e);

    expect([(err as HttpError).code, (err as HttpError).message]).toEqual([
      "settings_changed",
      "The post was saved while this was being scheduled. Try again.",
    ]);
    expect(saves).toBe(3);
    expect(await sends.getActiveSendForPost(env.DB, post.id)).toBeNull();
    const after = (await posts.getPost(env.DB, post.id))!;
    expect(after.status).toBe("draft");
  });

  it("writes neither the post's listing nor its earlier sends' numbers on a try that doesn't land", async () => {
    // A post with a canceled send behind it, whose number a landed listing change would move.
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Subj", markdown: "draft 0" },
      "test",
    );
    const earlier = await freeze(env, config(), post, Date.now() + 600_000);
    await cancel(env, earlier.id);
    const rev = (await sends.getSend(env.DB, earlier.id))!.rev;
    const draft = (await posts.getPost(env.DB, post.id))!;
    let saves = 0;
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      saves += 1;
      const current = (await posts.getPost(db, post.id))!;
      await posts.updatePost(db, current, { markdown: `draft ${saves}` }, "test");
      return 0;
    });

    const err = await freeze(env, config(), draft, Date.now() + 600_000, { emailOnly: true }).catch(
      (e: unknown) => e,
    );

    expect((err as HttpError).code).toBe("settings_changed");
    expect((await posts.getPost(env.DB, post.id))!.email_only).toBe(false);
    expect((await sends.getSend(env.DB, earlier.id))!.rev).toBe(rev);
  });

  it("answers not found, freezing nothing, when the post is deleted in the gap", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "body" }, "test");
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      await posts.deletePost(db, post.id);
      return 0;
    });

    const err = await freeze(env, config(), post, Date.now() + 600_000).catch((e: unknown) => e);

    expect((err as HttpError).code).toBe("not_found");
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sends").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("refuses with the send that won when a freeze of the same post lands in the gap", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "first" }, "test");
    let winner: sends.SendRow | undefined;
    let raced = false;
    vi.spyOn(subscribersDb, "audienceCount").mockImplementation(async (db) => {
      // Once, and set first: the other client's freeze below counts the audience too.
      if (!raced) {
        raced = true;
        // A save, then another client's freeze of the saved post, both before this one writes.
        const saved = await posts.updatePost(db, post, { markdown: "second" }, "test");
        winner = await freeze(env, config(), saved.post, Date.now() + 600_000);
      }
      return 0;
    });

    const err = await freeze(env, config(), post, Date.now() + 600_000).catch((e: unknown) => e);

    expect((err as HttpError).code).toBe("active_send_exists");
    expect(((err as HttpError).details?.send as { id: string }).id).toBe(winner!.id);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sends").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("refuses with the post's own refusal when a save in the gap emptied its subject", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown: "body" }, "test");
    await posts.updatePost(env.DB, post, { subject: "  " }, "test");

    const err = await freeze(env, config(), post, Date.now() + 600_000).catch((e: unknown) => e);

    expect((err as HttpError).code).toBe("subject_required");
    expect(await sends.getActiveSendForPost(env.DB, post.id)).toBeNull();
    expect((await posts.getPost(env.DB, post.id))!.status).toBe("draft");
  });
});

describe("send loop + sweep", () => {
  it("delivers a due send to the whole audience and completes (I1)", async () => {
    await seedConfirmed(["a@example.com", "b@example.com", "c@example.com"]);
    // Everyone else on the list, none of whom the audience may reach (I1): a reader who
    // never confirmed, one who left, and a confirmed reader whose address is suppressed.
    await env.DB.prepare(
      `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at, unsubscribe_cause) VALUES
         ('id-p', 'pending@example.com', 'pending', 'cfm-p', 'uns-p', ?1, NULL, NULL),
         ('id-u', 'left@example.com', 'unsubscribed', 'cfm-u', 'uns-u', ?1, ?1, 'reader')`,
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
    expect(send.recipient_count).toBe((await sendAudience()).length);
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
      env.DB.prepare(
        "UPDATE subscribers SET status = 'unsubscribed', unsubscribe_cause = 'reader' WHERE email = ?",
      )
        .bind(email)
        .run(),
    );
  });

  it("skips a recipient suppressed after audience resolution, at hand-off (SPEC §6, §10)", async () => {
    await leaveAfterResolution((email) =>
      env.DB.prepare(
        "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'bounce', '550 5.1.1 user unknown', ?)",
      )
        .bind(email, Date.now())
        .run(),
    );
  });
});
