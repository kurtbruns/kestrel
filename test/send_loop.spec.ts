import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { readSettings, updateSettings } from "../src/db/settings";
import * as subscribersDb from "../src/db/subscribers";
import { getConfig } from "../src/env";
import { MISSED_THRESHOLD_MS } from "../src/lib/time";
import { clearFakeOutbox, failFakeSendBatch, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { toNextTick } from "./support/clock";

const config = () => getConfig(env);

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

async function scheduledSend(fireAt: number, markdown = "# Hi\n\nbody") {
  const { post } = await posts.createPost(env.DB, { subject: "Subj", markdown }, "test");
  return freeze(env, config(), post, fireAt);
}

const countTo = (email: string) => fakeOutbox().filter((m) => m.to === email).length;

// The sweep is global over all sends, so each test needs a clean slate (storage
// is not rolled back between tests in a file).
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
    const tpl = `<div>{{ post.body }} <i>{{ publication.tagline }}</i> <a href="{{ email.unsubscribeUrl }}">u</a></div>`;
    await updateSettings(env.DB, { emailTemplate: tpl });
    let bumped = false;
    const spy = vi.spyOn(subscribersDb, "audienceEmails").mockImplementation(async (db) => {
      // Runs after the render and before the insert, once: the "concurrent" save.
      if (!bumped) {
        bumped = true;
        await updateSettings(db, { publication: { tagline: "after" } });
      }
      return [];
    });
    try {
      const send = await freeze(env, config(), post, Date.now() + 600_000);
      expect(send.status).toBe("scheduled");
      expect(send.rendered_html).toContain("after");
      expect(send.rendered_html).not.toContain("before");
      expect((await posts.getPost(env.DB, post.id))!.status).toBe("scheduled");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("send loop + sweep", () => {
  it("delivers a due send to the whole audience and completes (I1)", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    await seedConfirmed("c@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    await sweep(env);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 3 });
    expect(fakeOutbox().length).toBe(3);
    // per-recipient unsubscribe link carries the subscriber's DURABLE unsub token
    // (not the one-shot confirm token), so it survives a later re-subscribe (I2).
    expect(fakeOutbox().every((m) => m.html.includes("/unsubscribe?token="))).toBe(true);
    const toA = fakeOutbox().find((m) => m.to === "a@example.com");
    expect(toA?.html).toContain("/unsubscribe?token=uns-a@example.com");
  });

  it("resumes after a mid-send crash and mails each recipient at most once (I4)", async () => {
    await seedConfirmed("x@example.com");
    await seedConfirmed("y@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    failFakeSendBatch(1); // first send call throws
    await sweep(env);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(fakeOutbox().length).toBe(0);
    expect(await sends.countDeliveries(env.DB, send.id, "pending")).toBe(2);

    // The failed request halted the run, so the send waits out its first backoff step.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await sweep(env);
      expect(fakeOutbox().length).toBe(0);
      await toNextTick(env.DB);
      await sweep(env); // resume
    } finally {
      vi.useRealTimers();
    }
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 2 });
    expect(countTo("x@example.com")).toBe(1);
    expect(countTo("y@example.com")).toBe(1);
  });

  it("flags a missed fire time loudly but still delivers (§12)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedConfirmed("late@example.com");
    const send = await scheduledSend(Date.now() - (MISSED_THRESHOLD_MS + 60_000));

    await sweep(env);

    const flagged = spy.mock.calls.some((c) => c[0] === "MISSED_FIRE");
    expect(flagged).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(countTo("late@example.com")).toBe(1);
    spy.mockRestore();
  });

  it("overlapping runs: exactly one acquires the lease (no double send)", async () => {
    await seedConfirmed("o1@example.com");
    await seedConfirmed("o2@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    const [a, b] = await Promise.all([runSend(env, send.id), runSend(env, send.id)]);
    expect([a.leased, b.leased].filter(Boolean).length).toBe(1);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(countTo("o1@example.com")).toBe(1);
    expect(countTo("o2@example.com")).toBe(1);
  });

  it("does not fire a scheduled send whose fire time is still in the future (reschedule-vs-sweep race, I6)", async () => {
    // The sweep snapshots due sends and then leases each one; a reschedule that moves a
    // just-due send forward lands in that gap, leaving the row `scheduled` at a new,
    // future fire_at. acquireLease re-checks fire_at (not just status), so runSend on a
    // not-yet-due scheduled send is a no-op — the send is never fired at its old time
    // after the API accepted the move. Without the guard this would lease, dispatch, and
    // mail the audience.
    await seedConfirmed("soon@example.com");
    const send = await scheduledSend(Date.now() + 10 * 60 * 1000);

    const result = await runSend(env, send.id);

    expect(result.leased).toBe(false);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("scheduled");
    expect(fakeOutbox().length).toBe(0);
  });

  it("skips a recipient who unsubscribed after audience resolution (I2)", async () => {
    await seedConfirmed("keep@example.com");
    await seedConfirmed("gone@example.com");
    const send = await scheduledSend(Date.now() - 1000);

    // Simulate: 'gone' had a pending delivery row (confirmed at resolution),
    // then unsubscribed before dispatch.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries (id, send_id, email, status, attempts, updated_at) VALUES (?, ?, 'gone@example.com', 'pending', 0, ?)",
    )
      .bind("d-gone", send.id, Date.now())
      .run();
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'gone@example.com'",
    ).run();

    await sweep(env);

    expect(countTo("keep@example.com")).toBe(1);
    expect(countTo("gone@example.com")).toBe(0);
    const rollup = await sends.deliveryRollup(env.DB, send.id);
    expect(rollup.skipped).toBeGreaterThanOrEqual(1);
  });
});
