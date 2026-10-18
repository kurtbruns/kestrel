import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { dashboardRouteFromSearch } from "../shared/dashboard_link";
import { refusalAdvice } from "../shared/sends";
import type { SendNotificationKind } from "../shared/settings";
import * as notifications from "../src/db/notifications";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { MAX_NOTIFY_ATTEMPTS, MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../src/lib/time";
import * as channel from "../src/notify/channel";
import { CloudflareNotifier, ProviderNotifier } from "../src/notify/channel";
import { composeNotification, sendLink } from "../src/notify/compose";
import { clearFakeNotifications, failFakeNotify, fakeNotifications } from "../src/notify/fake";
import { stillHolds } from "../src/notify/notify";
import * as providers from "../src/providers";
import { sweep } from "../src/send/sweep";
import { BatchProvider } from "./support/batching";
import { guardD1 } from "./support/d1_guard";
import { SES_DEPLOY } from "./support/deploy";
import {
  addresses,
  dueSend,
  frozenSend,
  resetDatabase,
  seedConfirmed,
  tick,
  ticks,
} from "./support/fixtures";
import { AUTH, base, JSON_AUTH } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { fetchWith } from "./support/worker_env";

// The publisher is told, by email, when a send goes out or runs into a problem (SPEC §8): once per
// event, however many ticks the condition lasts, through a channel that is the fake here
// (the test env is dev-shaped), and never at a cost to any send (I1 to I6).

const PUBLISHER = "publisher@example.com";

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

let transport: BatchProvider;
let errors: MockInstance;
let warnings: MockInstance;

beforeEach(async () => {
  await resetDatabase();
  await updateSettings(env.DB, { notifications: { to: PUBLISHER } });
  clearFakeNotifications();
  // Only Date is faked, so `ticks` can move the clock past a halt's backoff.
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockReturnValue(transport);
  errors = vi.spyOn(console, "error");
  warnings = vi.spyOn(console, "warn");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a send finishing", () => {
  it("tells the publisher once, with the record's headline numbers and a link to it", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend({ subject: "Owls in winter" });

    await ticks(4);

    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    const sent = fakeNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PUBLISHER);
    expect(sent[0]!.subject).toBe("Sent: Owls in winter");
    expect(sent[0]!.text).toContain("Accepted by the provider: 3 of 3. Unsent: 0. Skipped");
    // In the query, not the hash, so an Access login in between keeps it.
    expect(sent[0]!.text).toContain(`/dashboard/?to=/sent/${send.id}`);
    expect(await rows(send.id)).toMatchObject([{ kind: "finished", status: "sent", attempts: 1 }]);
    // Nothing about it reached the list: the subscribers were mailed once each, the
    // publisher not at all through the newsletter's provider.
    expect(transport.mailed).toHaveLength(3);
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
    allowErrorLogs("send.stuck");
    await seedConfirmed(addresses(5));
    const send = await dueSend({ subject: "Owls in winter" });
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";

    await ticks(1);
    const [refused] = fakeNotifications();
    expect(refused!.subject).toBe(
      'Problem with "Owls in winter": the provider is refusing your account',
    );
    expect(refused!.text).toContain("security token included in the request is invalid");
    expect(refused!.text).toContain(
      "Whoever runs the deployment replaces the SES access key in its secrets, or gives the key ses:SendEmail and ses:SendBulkEmail in its IAM policy.",
    );
    expect(refused!.text).toContain("No one has been marked unsent because of this");

    await ticks(5);
    expect(fakeNotifications()).toHaveLength(1);

    // Fixed: the send resumes on its own and finishing is a notification of its own.
    transport.refuse = null;
    await ticks(3);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(fakeNotifications().map((n) => n.subject)).toEqual([
      'Problem with "Owls in winter": the provider is refusing your account',
      "Sent: Owls in winter",
    ]);
  });

  it("a refusal that lifts and returns is a new event", async () => {
    /** Answers one batch once `relapse` is set, then refuses again for that reason: the
     *  account fixed long enough for a batch to land, then refused once more. */
    class Relapsing extends BatchProvider {
      relapse: string | null = null;
      override async sendBatch(
        ...args: Parameters<BatchProvider["sendBatch"]>
      ): ReturnType<BatchProvider["sendBatch"]> {
        const result = await super.sendBatch(...args);
        if (result.kind === "answered" && this.relapse) {
          this.refuse = this.relapse;
          this.relapse = null;
        }
        return result;
      }
    }
    const relapsing = new Relapsing();
    vi.spyOn(providers, "getProvider").mockReturnValue(relapsing);
    // More than one batch, so the send is still going when the refusal returns.
    await seedConfirmed(addresses(3 * relapsing.maxBatch));
    const send = await dueSend({ subject: "Owls in winter" });
    relapsing.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";

    await ticks(2);
    const first = (await sends.getSend(env.DB, send.id))!.halted_at;
    expect(first).not.toBeNull();
    expect(relapsing.mailed).toHaveLength(0);

    // The key is replaced: a batch is answered, which lifts the refusal, and the next is
    // refused again.
    relapsing.refuse = null;
    relapsing.relapse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    await ticks(1);
    expect(relapsing.mailed).toHaveLength(relapsing.maxBatch);
    const second = (await sends.getSend(env.DB, send.id))!.halted_at;
    expect(second).toBeGreaterThan(first!);

    expect((await rows(send.id)).map((r) => [r.kind, r.episode])).toEqual([
      ["refused", first],
      ["refused", second],
    ]);
    expect(fakeNotifications().map((n) => n.subject)).toEqual([
      'Problem with "Owls in winter": the provider is refusing your account',
      'Problem with "Owls in winter": the provider is refusing your account',
    ]);
  });

  it("a send in flight past the threshold: told once, and not while a refusal already says why", async () => {
    await seedConfirmed(addresses(1));
    const slow = await dueSend({ subject: "Slow one" });
    const refused = await dueSend({ subject: "Refused one" });
    const long = Date.now() - STUCK_THRESHOLD_MS - 60_000;
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 1 WHERE id IN (?, ?)",
    )
      .bind(long, slow.id, refused.id)
      .run();
    await env.DB.prepare(
      "UPDATE sends SET halt_reason = 'account', halted_at = ?, halt_error = 'suspended', halt_retry_at = ? WHERE id = ?",
    )
      .bind(long, Date.now() + 5 * 60_000, refused.id)
      .run();

    await notifications.recordNotifications(env.DB, Date.now());
    await notifications.recordNotifications(env.DB, Date.now());

    expect((await rows(slow.id)).map((r) => r.kind)).toEqual(["stuck"]);
    expect((await rows(refused.id)).map((r) => r.kind)).toEqual(["refused"]);
  });

  it("a wedged send awaiting Resolve: told once, naming how many recipients are unknown", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend({ subject: "Wedged one" });
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 0, c_in_flight = 4, locked_until = NULL WHERE id = ?",
    )
      .bind(Date.now(), send.id)
      .run();

    await notifications.recordNotifications(env.DB, Date.now());
    await notifications.recordNotifications(env.DB, Date.now());
    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["wedged"]);

    // A run still holding the lease is finishing its last batch, not wedged.
    const held = await dueSend({ subject: "Held one" });
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 0, c_in_flight = 4, locked_until = ? WHERE id = ?",
    )
      .bind(Date.now(), Date.now() + 60_000, held.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    expect(await rows(held.id)).toEqual([]);
  });

  it("a missed fire time: told once, whether the send went out late or has not gone out", async () => {
    allowErrorLogs("send.missed");
    await seedConfirmed(addresses(2));
    const late = await frozenSend(Date.now() - MISSED_THRESHOLD_MS - 5 * 60_000, {
      subject: "Late one",
    });

    await ticks(3);
    const subjects = fakeNotifications().map((n) => n.subject);
    expect(subjects).toContain('Problem with "Late one": it missed its fire time');
    expect(subjects).toContain("Sent: Late one");
    expect(fakeNotifications().find((n) => n.subject.startsWith("Problem"))!.text).toContain(
      "minutes late",
    );
    expect((await rows(late.id)).map((r) => r.kind).sort()).toEqual(["finished", "missed"]);

    // One the sweep cannot fire stays scheduled, and is reported as not gone out.
    const stranded = await frozenSend(Date.now() - MISSED_THRESHOLD_MS - 60_000, {
      subject: "Stranded",
    });
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

describe("a signup the SES sandbox refuses", () => {
  /** A provider in the SES sandbox: it refuses every confirmation, naming the reader. */
  function sandboxed() {
    transport.sendBatch = async (_r, recipients) => ({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "sandbox",
        error: `ses 400 MessageRejected: Email address is not verified. The following identities failed the check in region US-EAST-1: ${recipients[0]!.email}`,
      },
    });
  }
  const signUp = (email: string) =>
    fetchWith({}, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("tells the publisher at most once a day, naming no reader, since the reader is told a link is coming (SPEC §7, §8)", async () => {
    sandboxed();
    await signUp("ada@example.com");
    await signUp("bo@example.com");
    await tick();

    const sent = fakeNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(
      "A signup's confirmation was refused: SES is still in the sandbox",
    );
    expect(sent[0]!.text).toContain(refusalAdvice("sandbox"));
    expect(sent[0]!.text).not.toContain("ada@example.com");
    expect(sent[0]!.text).toContain("/dashboard/?to=/subscribers");

    // The next UTC day's first refusal is told again.
    vi.setSystemTime(notifications.utcDayStart(Date.now()) + 86_400_000 + 1_000);
    await signUp("cy@example.com");
    await tick();
    expect(fakeNotifications()).toHaveLength(2);
  });

  it("tells nothing for a confirmation refused for any other reason", async () => {
    transport.refuse = "ses 403 UnrecognizedClientException: bad key";
    await signUp("ada@example.com");
    await tick();
    expect(fakeNotifications()).toHaveLength(0);
  });
});

describe("isolation", () => {
  it("a channel that fails leaves the send alone, shows on the settings surface, and retries next tick", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend({ subject: "Owls in winter" });
    failFakeNotify(1);
    const surface = async () =>
      (
        (await (await SELF.fetch(`${base}/api/settings`, { headers: AUTH })).json()) as {
          notification_status: Awaited<ReturnType<typeof notifications.notificationStatus>>;
        }
      ).notification_status;

    await ticks(1);
    const failed = (await sends.getSend(env.DB, send.id))!;
    expect(failed.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toEqual({ accepted: 3 });
    expect(fakeNotifications()).toHaveLength(0);
    expect(await surface()).toMatchObject({
      last_sent: null,
      last_failure: {
        kind: "finished",
        subject: "Owls in winter",
        error: "fake notification failure",
      },
    });

    await ticks(1);
    expect(fakeNotifications()).toHaveLength(1); // the retry got through
    expect(await surface()).toMatchObject({
      last_sent: { kind: "finished", subject: "Owls in winter" },
      last_failure: null,
    });
    expect(logged(warnings)).toContainEqual(
      expect.objectContaining({ event: "notify.failed", sendId: send.id, kind: "finished" }),
    );
  });

  it("gives up after the cap and says so, never mailing the list or changing the record", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend({ subject: "Owls in winter" });
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
    expect(transport.mailed).toHaveLength(2);
    const status = await notifications.notificationStatus(env.DB);
    expect(status.last_sent).toBeNull();
    expect(status.last_failure).toMatchObject({
      kind: "finished",
      subject: "Owls in winter",
      error: "fake notification failure",
    });
  });

  it("logs what it tells the publisher without the publisher's address", async () => {
    allowErrorLogs("notify.error");
    const infos = vi.spyOn(console, "log");
    await seedConfirmed(addresses(2));
    await dueSend({ subject: "Owls in winter" });
    failFakeNotify(1);
    await ticks(3); // a failed try, then the retry that gets through
    vi.spyOn(channel, "getNotifier").mockImplementation(() => {
      throw new Error("no channel at all");
    });
    await dueSend({ subject: "Owls in spring" });
    await ticks(2);

    const lines = logged(infos, warnings, errors).filter((l) => l.event.startsWith("notify."));
    expect(new Set(lines.map((l) => l.event))).toEqual(
      new Set(["notify.failed", "notify.sent", "notify.error"]),
    );
    const local = PUBLISHER.split("@")[0];
    for (const line of lines) {
      expect(JSON.stringify(line).toLowerCase()).not.toContain(`${local}@`);
    }
  });

  it("a notifier that throws outright never stops a send finishing", async () => {
    allowErrorLogs("notify.error");
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
    allowErrorLogs("send.missed");
    await seedConfirmed(addresses(1));
    for (let i = 0; i < 25; i++) {
      await frozenSend(Date.now() - MISSED_THRESHOLD_MS - 60_000, { subject: `Backlog ${i}` });
    }
    const guard = guardD1(env.DB);
    const capped = { ...env, DB: guard.db } as AppEnv;
    const limit = getConfig(capped).subrequestBudget;

    for (let i = 0; i < 6; i++) {
      const before = guard.statements;
      const mailedBefore = transport.requests;
      const notifiedBefore = fakeNotifications().length;
      await sweep(capped);
      const spent =
        guard.statements -
        before +
        (transport.requests - mailedBefore) +
        (fakeNotifications().length - notifiedBefore);
      expect(spent).toBeLessThanOrEqual(limit);
      // At least one notification every tick, however much the sends spent.
      expect(fakeNotifications().length, `tick ${i}`).toBeGreaterThan(notifiedBefore);
    }
  });
});

describe("after the review", () => {
  it("a send that resumes after a long refusal is not then reported as stuck", async () => {
    await seedConfirmed(addresses(1));
    const send = await dueSend({ subject: "Resumed one" });
    const long = Date.now() - STUCK_THRESHOLD_MS - 60 * 60_000;
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, c_pending = 1, halt_reason = 'account', halted_at = ?, halt_retry_at = ? WHERE id = ?",
    )
      .bind(long, long, Date.now() + 60 * 60_000, send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());
    // The account is fixed: the provider answers, which lifts the refusal and is progress,
    // and the send is back to work, long past its start.
    await env.DB.prepare(
      "UPDATE sends SET halt_reason = NULL, halted_at = NULL, halt_error = NULL, progress_at = ? WHERE id = ?",
    )
      .bind(Date.now(), send.id)
      .run();
    await notifications.recordNotifications(env.DB, Date.now());

    expect((await rows(send.id)).map((r) => r.kind)).toEqual(["refused"]);
  });

  it("a problem that clears before its notification gets through is dropped, not sent late", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend({ subject: "Owls in winter" });
    transport.refuse =
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid";
    failFakeNotify(1);
    await ticks(1);
    expect(await rows(send.id)).toMatchObject([
      { kind: "refused", status: "pending", error: "fake notification failure" },
    ]);

    transport.refuse = null;
    await ticks(3);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(fakeNotifications().map((n) => n.subject)).toEqual(["Sent: Owls in winter"]);
    const byKind = Object.fromEntries((await rows(send.id)).map((r) => [r.kind, r.status]));
    expect(byKind).toEqual({ refused: "cleared", finished: "sent" });
    // A cleared notification is not a channel failure.
    expect((await notifications.notificationStatus(env.DB)).last_failure).toBeNull();
  });

  it("a test that gets through clears Not delivered, and a failed one takes its place", async () => {
    await seedConfirmed(addresses(1));
    await dueSend();
    failFakeNotify(100);
    await ticks(MAX_NOTIFY_ATTEMPTS + 2);
    expect((await notifications.notificationStatus(env.DB)).last_failure).not.toBeNull();

    clearFakeNotifications();
    const test = async () =>
      SELF.fetch(`${base}/api/settings/notifications/test`, {
        method: "POST",
        headers: AUTH,
      });
    expect((await test()).status).toBe(200);
    let status = await notifications.notificationStatus(env.DB);
    expect(status.last_failure).toBeNull();
    expect(status.last_sent).toMatchObject({ kind: "test", subject: "" });

    failFakeNotify(1);
    expect((await test()).status).toBe(502);
    status = await notifications.notificationStatus(env.DB);
    expect(status.last_failure).toMatchObject({ kind: "test", error: "fake notification failure" });
    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'test'",
    ).first<{ n: number }>())!;
    expect(n).toBe(1); // only the latest test is kept
  });

  it("deleting a draft whose canceled send has a notification deletes it too", async () => {
    await seedConfirmed(addresses(1));
    const send = await frozenSend(Date.now() + 24 * 60 * 60 * 1000, { subject: "Canceled one" });
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
    const config = { ...getConfig(env), provider: "ses" as const };
    const notifier = new ProviderNotifier(config, env as AppEnv);
    await notifier.send(PUBLISHER, { subject: "S", text: "T", html: "" }, "send1-finished-0");
    expect(transport.mailed).toEqual([{ to: PUBLISHER, key: "notify-send1-finished-0:1" }]);

    transport.refuse = "ses 400 MailFromDomainNotVerifiedException: domain not verified";
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
    const deployed = { ...SES_DEPLOY, APP_ORIGIN: "https://newsletter.birds.example" };
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
      notifyFrom: SES_DEPLOY.FROM_ADDRESS,
    });
  });
});

describe("the settings surface", () => {
  const put = async (patch: unknown) =>
    SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify(patch),
    });
  const get = async () =>
    (await (await SELF.fetch(`${base}/api/settings`, { headers: AUTH })).json()) as any;
  const test = async () =>
    SELF.fetch(`${base}/api/settings/notifications/test`, {
      method: "POST",
      headers: AUTH,
    });

  it("stores the address as a preference, normalized, and reflects the channel read-only", async () => {
    const res = await put({ notifications: { to: "  Me@Example.COM " } });
    expect(res.status).toBe(200);
    const body = await get();
    expect(body.settings.notifications).toEqual({ to: "me@example.com" });
    expect(body.deployment.notify_channel).toBe("fake");
    expect(body.deployment.notify_from).toBe(env.FROM_ADDRESS);
    expect(body.notification_status).toEqual({ last_sent: null, last_failure: null });
  });

  it("refuses an address that isn't one, and a wrong type naming the field", async () => {
    expect((await put({ notifications: { to: "not-an-address" } })).status).toBe(400);
    const wrong = await put({ notifications: { to: 5 } });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).field).toBe("notifications.to");
  });

  it("changing the address asks nothing of scheduled sends: it is not an input to any email", async () => {
    await frozenSend(Date.now() + 24 * 60 * 60 * 1000, { subject: "Scheduled one" });
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
    // Its link opens Settings, carried in the query so an Access login keeps it.
    expect(JSON.stringify(fakeNotifications()[0])).toContain("/dashboard/?to=/settings");

    failFakeNotify(1);
    const refused = await test();
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      error: "notify_failed",
      message: "fake notification failure",
    });
  });
});

describe("the link in a notification", () => {
  it("opens the send's own page, carried in the query, for every kind", () => {
    const config = getConfig(env);
    const kinds: SendNotificationKind[] = ["finished", "refused", "stuck", "wedged", "missed"];
    for (const kind of kinds) {
      const email = composeNotification(
        {
          send_id: "s 1",
          kind,
          episode: 0,
          attempts: 0,
          subject: "Owls",
          send_status: "sent",
          fire_at: 0,
          started_at: null,
          completed_at: null,
          locked_until: null,
          halt_reason: null,
          halted_at: null,
          halt_retry_at: null,
          progress_at: null,
          halt_cause: null,
          halt_error: null,
          c_pending: 0,
          c_in_flight: 0,
          c_accepted: 0,
          c_delivered: 0,
          c_bounced: 0,
          c_complained: 0,
          c_skipped: 0,
          c_unsent: 0,
        },
        config,
      );
      const link = sendLink(config, "s 1");
      if (kind === "wedged") {
        // Kestrel can't tell whether a lost request went out, so the advice names the safe choice.
        expect(email.text).toContain("Assume not sent is the safe default");
      }
      expect(email.text, kind).toContain(link);
      expect(email.html, kind).toContain(`href="${link}"`);
      // The editor opens the page the link names, with the id's own encoding intact.
      expect(new URL(link).pathname, kind).toBe("/dashboard/");
      expect(dashboardRouteFromSearch(new URL(link).search), kind).toBe("#/sent/s%201");
    }
  });
});

describe("what the publisher is told agrees with what every surface shows (SPEC §8)", () => {
  // The email words a problem for a reader opening it cold, and the editor and the API word
  // it for a page beside the send, so the sentences differ by design. What can't differ is
  // the rule (a problem is told exactly when the send shows its condition) and the facts
  // (the provider's words, the fix, how many recipients). Each case is one send state.
  const TOLD = ["refused", "stuck", "wedged", "missed"];
  const MIN = 60_000;
  const cases: { name: string; state: (now: number) => Record<string, number | string | null> }[] =
    [
      {
        name: "refused: the account",
        state: (now) => ({
          status: "sending",
          started_at: now - 5 * MIN,
          progress_at: now - 5 * MIN,
          c_pending: 4,
          halt_reason: "account",
          halt_cause: "credentials",
          halt_error: "The security token included in the request is invalid",
          halted_at: now - 4 * MIN,
          halt_retries: 1,
          halt_retry_at: now + 10 * MIN,
        }),
      },
      {
        name: "refused: the send's own email",
        state: (now) => ({
          status: "sending",
          started_at: now - 5 * MIN,
          progress_at: now - 5 * MIN,
          c_pending: 4,
          halt_reason: "account",
          halt_cause: "content",
          halt_error: "Message rejected",
          halted_at: now - 4 * MIN,
          halt_retries: 1,
          halt_retry_at: now + 10 * MIN,
        }),
      },
      {
        name: "unavailable: shown, not told",
        state: (now) => ({
          status: "sending",
          started_at: now - 5 * MIN,
          progress_at: now - 5 * MIN,
          c_pending: 4,
          halt_reason: "unavailable",
          halt_cause: "outage",
          halt_error: "Service unavailable",
          halted_at: now - 4 * MIN,
          halt_retries: 1,
          halt_retry_at: now + 1 * MIN,
        }),
      },
      {
        name: "stuck",
        state: (now) => ({
          status: "sending",
          started_at: now - 60 * MIN,
          progress_at: now - 40 * MIN,
          c_pending: 4,
        }),
      },
      {
        name: "slow but moving",
        state: (now) => ({
          status: "sending",
          started_at: now - 60 * MIN,
          progress_at: now - 2 * MIN,
          c_pending: 4,
        }),
      },
      {
        name: "wedged",
        state: (now) => ({
          status: "sending",
          started_at: now - 20 * MIN,
          progress_at: now - 15 * MIN,
          c_pending: 0,
          c_in_flight: 3,
          locked_until: null,
        }),
      },
      {
        name: "wedged after a refusal",
        state: (now) => ({
          status: "sending",
          started_at: now - 20 * MIN,
          progress_at: now - 15 * MIN,
          c_pending: 0,
          c_in_flight: 3,
          locked_until: null,
          halt_reason: "account",
          halt_cause: "quota",
          halt_error: "Daily quota exceeded",
          halted_at: now - 10 * MIN,
          halt_retries: 2,
          halt_retry_at: now + 20 * MIN,
        }),
      },
      { name: "missed", state: (now) => ({ status: "scheduled", fire_at: now - 10 * MIN }) },
      {
        name: "due, inside the tolerance",
        state: (now) => ({ status: "scheduled", fire_at: now - 2 * MIN }),
      },
    ];

  async function setUp(state: Record<string, number | string | null>) {
    const send = await frozenSend(Date.now() + 60 * MIN);
    const cols = Object.keys(state);
    await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .bind(...cols.map((c) => state[c] ?? null), send.id)
      .run();
    return send;
  }

  async function shown(id: string) {
    const res = await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH });
    const { send } = (await res.json()) as {
      send: {
        conditions: {
          kind: string;
          message: string;
          advice?: string;
          error?: string;
          count?: number;
        }[];
      };
    };
    return send.conditions;
  }

  for (const c of cases) {
    it(`${c.name}: told exactly when the send shows the condition, with its facts`, async () => {
      const now = Date.now();
      const send = await setUp(c.state(now));
      await notifications.recordNotifications(env.DB, now);
      const conditions = await shown(send.id);
      const showing = conditions
        .map((cond) => cond.kind)
        .filter((k) => TOLD.includes(k))
        .sort();
      const told = (await rows(send.id))
        .map((r) => r.kind)
        .filter((k) => TOLD.includes(k))
        .sort();
      expect(told).toEqual(showing);
      // And each told problem still holds by the notifier's own check, as it would before sending.
      const due = (await notifications.dueNotifications(env.DB, 10)).filter(
        (n): n is notifications.DueNotification => n.send_id === send.id && TOLD.includes(n.kind),
      );
      expect(due.map((n) => n.kind).sort()).toEqual(showing);
      expect(
        due
          .filter((n) => stillHolds(n, now))
          .map((n) => n.kind)
          .sort(),
      ).toEqual(showing);
      // The email carries what the condition does: the provider's words, the fix, the count.
      const config = getConfig(env as unknown as AppEnv);
      for (const n of due) {
        const email = composeNotification(n, config).text;
        const cond = conditions.find((x) => x.kind === n.kind);
        if (n.kind === "refused") {
          expect(email).toContain(cond?.error);
          expect(cond?.message).toContain(cond?.advice);
          expect(email).toContain(cond?.advice);
          expect(cond?.message).toContain("No one has been marked unsent");
          expect(email).toContain("No one has been marked unsent");
        }
        if (n.kind === "wedged") {
          expect(cond?.count).toBe(3);
          expect(cond?.message).toContain("never answered for 3 recipients");
          expect(email).toContain("never answered for 3 recipients");
        }
      }
    });
  }

  it("a refusal two sends share is told for the one still held, when the other has wedged", async () => {
    // One account refusal holds both sends (the second joined it, so they share when it
    // began); the first then wedges on a request that got no answer. The refusal still
    // holds the second, so it is told there, not lost behind the wedged one.
    const now = Date.now();
    const halt = {
      halt_reason: "account",
      halt_cause: "quota",
      halt_error: "Daily quota exceeded",
      halted_at: now - 10 * MIN,
      halt_retries: 2,
      halt_retry_at: now + 20 * MIN,
    };
    const a = await setUp({
      status: "sending",
      started_at: now - 20 * MIN,
      progress_at: now - 15 * MIN,
      c_pending: 4,
      ...halt,
    });
    const b = await setUp({
      status: "sending",
      started_at: now - 20 * MIN,
      progress_at: now - 15 * MIN,
      c_pending: 4,
      ...halt,
    });
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    await env.DB.prepare(
      "UPDATE sends SET c_pending = 0, c_in_flight = 3, locked_until = NULL WHERE id = ?",
    )
      .bind(first.id)
      .run();
    await notifications.recordNotifications(env.DB, now);
    expect((await rows(first.id)).map((r) => r.kind)).toEqual(["wedged"]);
    expect((await rows(second.id)).map((r) => r.kind)).toEqual(["refused"]);
    expect((await shown(second.id)).map((cond) => cond.kind)).toContain("refused");
  });
});
