import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as notifications from "../src/db/notifications";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { MAX_NOTIFY_ATTEMPTS, MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../src/lib/time";
import * as channel from "../src/notify/channel";
import { CloudflareNotifier, ProviderNotifier } from "../src/notify/channel";
import { clearFakeNotifications, failFakeNotify, fakeNotifications } from "../src/notify/fake";
import * as providers from "../src/providers";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { adminAuth } from "./support/auth";
import { toNextTick } from "./support/clock";
import { guardD1 } from "./support/d1_guard";
import { RESEND_DEPLOY } from "./support/deploy";
import { logged } from "./support/log";
import { ResendLikeProvider } from "./support/resend_like";

// The publisher is told, by email, when a send goes out or runs into a problem (SPEC §8): once per
// event, however many ticks the condition lasts, through a channel that is the fake here
// (the test env is dev-shaped), and never at a cost to any send (I1 to I6).

const BASE = "https://kestrel.test";
const PUBLISHER = "publisher@example.com";

const addresses = (n: number, tag = "n") =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(3, "0")}@example.com`);

async function seedConfirmed(emails: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at)
     SELECT 'id-' || value, value, 'confirmed', 'cfm-' || value, 'uns-' || value, ?, ? FROM json_each(?)`,
  )
    .bind(now, now, JSON.stringify(emails))
    .run();
}

async function dueSend(subject = "Owls in winter", fireAt = Date.now() - 1000) {
  const { post } = await posts.createPost(env.DB, { subject, markdown: "hi" }, "test");
  return freeze(env, getConfig(env), post, fireAt);
}

async function rows(sendId?: string) {
  const { results } = await env.DB.prepare(
    "SELECT send_id, kind, episode, status, attempts, error FROM notifications WHERE ? IS NULL OR send_id = ? ORDER BY created_at, kind",
  )
    .bind(sendId ?? null, sendId ?? null)
    .all<{
      send_id: string;
      kind: string;
      episode: number;
      status: string;
      attempts: number;
      error: string | null;
    }>();
  return results;
}

/** Sweep ticks, each on the next minute or the next halt retry, whichever is later. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await toNextTick(env.DB);
    await sweep(env as AppEnv);
  }
}

let resend: ResendLikeProvider;
let errors: MockInstance;
let warnings: MockInstance;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM subscribers"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  await updateSettings(env.DB, { notifications: { to: PUBLISHER } });
  clearFakeNotifications();
  // Only Date is faked, so `ticks` can move the clock past a halt's backoff.
  vi.useFakeTimers({ toFake: ["Date"] });
  resend = new ResendLikeProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(resend);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a send finishing", () => {
  it("tells the publisher once, with the record's headline numbers and a link to it", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();

    await ticks(4);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    const sent = fakeNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PUBLISHER);
    expect(sent[0]!.subject).toBe("Sent: Owls in winter");
    expect(sent[0]!.text).toContain("Accepted by the provider: 3 of 3. Unsent: 0. Skipped");
    expect(sent[0]!.text).toContain(`/dashboard/#/sent/${send.id}`);
    expect(await rows(send.id)).toMatchObject([{ kind: "finished", status: "sent", attempts: 1 }]);
    // Nothing about it reached the list: the subscribers were mailed once each, the
    // publisher not at all through the newsletter's provider.
    expect(resend.mailed).toHaveLength(3);
  });

  it("with no address set, records the event as having nowhere to go and never mails a backlog", async () => {
    await updateSettings(env.DB, { notifications: { to: "" } });
    await seedConfirmed(addresses(2));
    const send = await dueSend();

    await ticks(2);
    expect(fakeNotifications()).toHaveLength(0);
    expect(await rows(send.id)).toMatchObject([{ kind: "finished", status: "unaddressed" }]);

    await updateSettings(env.DB, { notifications: { to: PUBLISHER } });
    await ticks(2);
    expect(fakeNotifications()).toHaveLength(0);
  });

  it("does not mail the history: a send that finished before the horizon is not news", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend();
    await ticks(2);
    await env.DB.prepare("DELETE FROM notifications").run();
    await env.DB.prepare("UPDATE sends SET completed_at = ? WHERE id = ?")
      .bind(Date.now() - 2 * 24 * 60 * 60 * 1000, send.id)
      .run();
    clearFakeNotifications();

    await ticks(1);
    expect(fakeNotifications()).toHaveLength(0);
  });
});

describe("a send that needs the publisher", () => {
  it("the provider refusing the account: told at once with its words and the advice, once however long it lasts", async () => {
    await seedConfirmed(addresses(5));
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";

    await ticks(1);
    const [refused] = fakeNotifications();
    expect(refused!.subject).toBe(
      'Problem with "Owls in winter": the provider is refusing your account',
    );
    expect(refused!.text).toContain("API key is invalid");
    expect(refused!.text).toContain("Replace the provider's API key");
    expect(refused!.text).toContain("No one has been marked unsent");

    await ticks(5);
    expect(fakeNotifications()).toHaveLength(1);

    // Fixed: the send resumes on its own and finishing is a notification of its own.
    resend.refuse = null;
    await ticks(3);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(fakeNotifications().map((n) => n.subject)).toEqual([
      'Problem with "Owls in winter": the provider is refusing your account',
      "Sent: Owls in winter",
    ]);
  });

  it("a refusal that lifts and returns is a new event", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend();
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, halt_reason = 'account', halted_at = ? WHERE id = ?",
    )
      .bind(Date.now(), 1000, send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    await notifications.recordNotifications(env.DB, Date.now());
    await env.DB.prepare("UPDATE sends SET halted_at = ? WHERE id = ?").bind(2000, send.id).run();
    await notifications.recordNotifications(env.DB, Date.now());

    expect((await rows(send.id)).map((r) => [r.kind, r.episode])).toEqual([
      ["refused", 1000],
      ["refused", 2000],
    ]);
  });

  it("a send in flight past the threshold: told once, and not while a refusal already says why", async () => {
    await seedConfirmed(addresses(1));
    const slow = await dueSend("Slow one");
    const refused = await dueSend("Refused one");
    const long = Date.now() - STUCK_THRESHOLD_MS - 60_000;
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 1 WHERE id IN (?, ?)",
    )
      .bind(long, slow.id, refused.id)
      .run();
    await env.DB.prepare(
      "UPDATE sends SET halt_reason = 'account', halted_at = ?, halt_error = 'suspended' WHERE id = ?",
    )
      .bind(long, refused.id)
      .run();

    await notifications.recordNotifications(env.DB, Date.now());
    await notifications.recordNotifications(env.DB, Date.now());

    expect((await rows(slow.id)).map((r) => r.kind)).toEqual(["stuck"]);
    expect((await rows(refused.id)).map((r) => r.kind)).toEqual(["refused"]);
  });

  it("a wedged send awaiting Resolve: told once, naming how many recipients are unknown", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend("Wedged one");
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 0, c_in_flight = 4, locked_until = NULL WHERE id = ?",
    )
      .bind(Date.now(), send.id)
      .run();

    await notifications.recordNotifications(env.DB, Date.now());
    await notifications.recordNotifications(env.DB, Date.now());
    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["wedged"]);

    // A run still holding the lease is finishing its last batch, not wedged.
    const held = await dueSend("Held one");
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 0, c_in_flight = 4, locked_until = ? WHERE id = ?",
    )
      .bind(Date.now(), Date.now() + 60_000, held.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    expect(await rows(held.id)).toEqual([]);
  });

  it("a missed fire time: told once, whether the send went out late or has not gone out", async () => {
    await seedConfirmed(addresses(2));
    const late = await dueSend("Late one", Date.now() - MISSED_THRESHOLD_MS - 5 * 60_000);

    await ticks(3);
    const subjects = fakeNotifications().map((n) => n.subject);
    expect(subjects).toContain('Problem with "Late one": it missed its fire time');
    expect(subjects).toContain("Sent: Late one");
    expect(fakeNotifications().find((n) => n.subject.startsWith("Problem"))!.text).toContain(
      "minutes late",
    );
    expect((await rows(late.id)).map((r) => r.kind).sort()).toEqual(["finished", "missed"]);

    // One the sweep cannot fire stays scheduled, and is reported as not gone out.
    const stranded = await dueSend("Stranded", Date.now() - MISSED_THRESHOLD_MS - 60_000);
    await notifications.recordNotifications(env.DB, Date.now());
    expect((await rows(stranded.id)).map((r) => r.kind)).toEqual(["missed"]);
  });

  it("a send on time is not late", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend();
    await ticks(2);
    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["finished"]);
  });
});

describe("isolation", () => {
  it("a channel that fails leaves the send alone, shows on the settings surface, and retries next tick", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    failFakeNotify(1);

    await ticks(2);
    const after = (await sends.getSend(env.DB, send.id))!;
    expect(after.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
    expect(fakeNotifications()).toHaveLength(1); // the retry got through
    expect(logged(warnings)).toContainEqual(
      expect.objectContaining({ event: "notify.failed", sendId: send.id, kind: "finished" }),
    );
  });

  it("gives up after the cap and says so, never mailing the list or changing the record", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    failFakeNotify(100);

    await ticks(MAX_NOTIFY_ATTEMPTS + 3);
    expect(fakeNotifications()).toHaveLength(0);
    expect(await rows(send.id)).toMatchObject([
      {
        kind: "finished",
        status: "failed",
        attempts: MAX_NOTIFY_ATTEMPTS,
        error: "fake notification failure",
      },
    ]);
    expect(resend.mailed).toHaveLength(2);
    const status = await notifications.notificationStatus(env.DB);
    expect(status.lastSent).toBeNull();
    expect(status.lastFailure).toMatchObject({
      kind: "finished",
      subject: "Owls in winter",
      error: "fake notification failure",
    });
  });

  it("a notifier that throws outright never stops a send finishing", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    vi.spyOn(channel, "getNotifier").mockImplementation(() => {
      throw new Error("no channel at all");
    });

    await ticks(2);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(logged(errors)).toContainEqual(
      expect.objectContaining({ event: "notify.error", error: "no channel at all" }),
    );
  });

  it("a tick with a backlog stays inside the subrequest budget", async () => {
    await seedConfirmed(addresses(1));
    for (let i = 0; i < 25; i++) {
      await dueSend(`Backlog ${i}`, Date.now() - MISSED_THRESHOLD_MS - 60_000);
    }
    const guard = guardD1(env.DB);
    const capped = { ...env, DB: guard.db } as AppEnv;
    const limit = getConfig(capped).subrequestBudget;

    for (let i = 0; i < 6; i++) {
      const before = guard.statements;
      const mailedBefore = resend.requests;
      const notifiedBefore = fakeNotifications().length;
      await sweep(capped);
      const spent =
        guard.statements -
        before +
        (resend.requests - mailedBefore) +
        (fakeNotifications().length - notifiedBefore);
      expect(spent).toBeLessThanOrEqual(limit);
    }
    // At least one notification a tick, however much the sends spent.
    expect(fakeNotifications().length).toBeGreaterThanOrEqual(6);
  });
});

describe("after the review", () => {
  it("a send that resumes after a long refusal is not then reported as stuck", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend("Resumed one");
    const long = Date.now() - STUCK_THRESHOLD_MS - 60 * 60_000;
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 1, halt_reason = 'account', halted_at = ? WHERE id = ?",
    )
      .bind(long, long, send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    // The account is fixed: the refusal lifts and the send is back to work, past the threshold.
    await env.DB.prepare(
      "UPDATE sends SET halt_reason = NULL, halted_at = NULL, halt_error = NULL WHERE id = ?",
    )
      .bind(send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());

    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["refused"]);
  });

  it("a problem that clears before its notification gets through is dropped, not sent late", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    resend.refuse = "resend batch 401: API key is invalid";
    failFakeNotify(1);
    await ticks(1);
    expect(await rows(send.id)).toMatchObject([
      { kind: "refused", status: "pending", error: "fake notification failure" },
    ]);

    resend.refuse = null;
    await ticks(3);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(fakeNotifications().map((n) => n.subject)).toEqual(["Sent: Owls in winter"]);
    const byKind = Object.fromEntries((await rows(send.id)).map((r) => [r.kind, r.status]));
    expect(byKind).toEqual({ refused: "cleared", finished: "sent" });
    // A cleared notification is not a channel failure.
    expect((await notifications.notificationStatus(env.DB)).lastFailure).toBeNull();
  });

  it("a test that gets through clears Not delivered, and a failed one takes its place", async () => {
    await seedConfirmed(addresses(1));
    await dueSend();
    failFakeNotify(100);
    await ticks(MAX_NOTIFY_ATTEMPTS + 2);
    expect((await notifications.notificationStatus(env.DB)).lastFailure).not.toBeNull();

    clearFakeNotifications();
    const test = async () =>
      SELF.fetch(`${BASE}/api/settings/notifications/test`, {
        method: "POST",
        headers: await adminAuth(),
      });
    expect((await test()).status).toBe(200);
    let status = await notifications.notificationStatus(env.DB);
    expect(status.lastFailure).toBeNull();
    expect(status.lastSent).toMatchObject({ kind: "test", subject: "" });

    failFakeNotify(1);
    expect((await test()).status).toBe(502);
    status = await notifications.notificationStatus(env.DB);
    expect(status.lastFailure).toMatchObject({ kind: "test", error: "fake notification failure" });
    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'test'",
    ).first<{ n: number }>())!;
    expect(n).toBe(1); // only the latest test is kept
  });

  it("deleting a draft whose canceled send has a notification deletes it too", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend("Canceled one", Date.now() + 24 * 60 * 60 * 1000);
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() - MISSED_THRESHOLD_MS - 60_000, send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["missed"]);

    // Past its window it can no longer be canceled through the API; the operator's own
    // database fix stands in, so the draft can be deleted.
    await env.DB.batch([
      env.DB.prepare("UPDATE sends SET status = 'canceled' WHERE id = ?").bind(send.id),
      env.DB.prepare("UPDATE posts SET status = 'draft' WHERE id = ?").bind(send.post_id),
    ]);
    await posts.deletePost(env.DB, send.post_id);
    expect(await rows(send.id)).toEqual([]);
    expect(await sends.getSend(env.DB, send.id)).toBeNull();
  });
});

describe("the channels", () => {
  it("Cloudflare's binding gets one message to the publisher, from the configured sender", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));
    const notifier = new CloudflareNotifier(
      { send } as unknown as SendEmail,
      "Kestrel <kestrel@newsletter.example.com>",
    );
    await notifier.send(PUBLISHER, { subject: "S", text: "T", html: "<p>T</p>" });
    expect(send).toHaveBeenCalledWith({
      from: { name: "Kestrel", email: "kestrel@newsletter.example.com" },
      to: PUBLISHER,
      subject: "S",
      text: "T",
      html: "<p>T</p>",
    });
  });

  it("Cloudflare's refusal surfaces as the channel's words", async () => {
    const notifier = new CloudflareNotifier(
      {
        send: async () => {
          throw new Error("E_RECIPIENT_NOT_ALLOWED: destination address not verified");
        },
      } as unknown as SendEmail,
      "kestrel@newsletter.example.com",
    );
    await expect(notifier.send(PUBLISHER, { subject: "S", text: "T", html: "" })).rejects.toThrow(
      "destination address not verified",
    );
  });

  it("the provider fallback delivers through the newsletter's provider, and fails with its words when it refuses", async () => {
    const config = { ...getConfig(env), provider: "resend" as const };
    const notifier = new ProviderNotifier(config, env as AppEnv);
    await notifier.send(PUBLISHER, { subject: "S", text: "T", html: "" }, "send1-finished-0");
    expect(resend.mailed).toEqual([{ to: PUBLISHER, key: "notify-send1-finished-0:1" }]);

    resend.refuse = "resend batch 403: domain not verified";
    await expect(
      notifier.send(PUBLISHER, { subject: "S", text: "T", html: "" }, "send1-refused-5"),
    ).rejects.toThrow("domain not verified");
  });
});

describe("the channel is deploy config", () => {
  const cfg = (over: Record<string, unknown>) => getConfig({ ...env, ...over } as AppEnv);
  const binding = { send: async () => ({}) } as unknown as SendEmail;

  it("dev is always the fake, even with the binding declared", () => {
    expect(cfg({ NOTIFY: binding }).notifyChannel).toBe("fake");
  });

  it("deployed: Cloudflare when bound, from kestrel@ the app's host unless NOTIFY_FROM says", () => {
    const deployed = { ...RESEND_DEPLOY, APP_ORIGIN: "https://newsletter.birds.example" };
    expect(cfg({ ...deployed, NOTIFY: binding })).toMatchObject({
      notifyChannel: "cloudflare",
      notifyFrom: "Kestrel <kestrel@newsletter.birds.example>",
    });
    expect(
      cfg({ ...deployed, NOTIFY: binding, NOTIFY_FROM: "alerts@newsletter.birds.example" })
        .notifyFrom,
    ).toBe("alerts@newsletter.birds.example");
    expect(cfg(deployed)).toMatchObject({
      notifyChannel: "provider",
      notifyFrom: RESEND_DEPLOY.FROM_ADDRESS,
    });
  });
});

describe("the settings surface", () => {
  const put = async (patch: unknown) =>
    SELF.fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { ...(await adminAuth()), "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  const get = async () =>
    (await (
      await SELF.fetch(`${BASE}/api/settings`, { headers: await adminAuth() })
    ).json()) as any;
  const test = async () =>
    SELF.fetch(`${BASE}/api/settings/notifications/test`, {
      method: "POST",
      headers: await adminAuth(),
    });

  it("stores the address as a preference, normalized, and reflects the channel read-only", async () => {
    const res = await put({ notifications: { to: "  Me@Example.COM " } });
    expect(res.status).toBe(200);
    const body = await get();
    expect(body.settings.notifications).toEqual({ to: "me@example.com" });
    expect(body.deployment.notifyChannel).toBe("fake");
    expect(body.deployment.notifyFrom).toBe(env.FROM_ADDRESS);
    expect(body.notificationStatus).toEqual({ lastSent: null, lastFailure: null });
  });

  it("refuses an address that isn't one, and a wrong type naming the field", async () => {
    expect((await put({ notifications: { to: "not-an-address" } })).status).toBe(400);
    const wrong = await put({ notifications: { to: 5 } });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).field).toBe("notifications.to");
  });

  it("changing the address asks nothing of scheduled sends: it is not an input to any email", async () => {
    await dueSend("Scheduled one", Date.now() + 24 * 60 * 60 * 1000);
    const res = await put({ notifications: { to: "other@example.com" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).remade).toEqual([]);
  });

  it("sends a test to the saved address only, and reports a refusing channel as a 502", async () => {
    await updateSettings(env.DB, { notifications: { to: "" } });
    expect((await test()).status).toBe(400);

    await updateSettings(env.DB, { notifications: { to: PUBLISHER } });
    const ok = await test();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ to: PUBLISHER, channel: "fake" });
    expect(fakeNotifications().map((n) => n.to)).toEqual([PUBLISHER]);

    failFakeNotify(1);
    const refused = await test();
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      error: "notify_failed",
      message: "fake notification failure",
    });
  });
});
