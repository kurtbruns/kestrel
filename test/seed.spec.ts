import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listSends } from "../src/db/sends";
import { getSettings, updateSettings } from "../src/db/settings";
import { audienceEmails, counts } from "../src/db/subscribers";
import { seedDatabase } from "../src/dev/seed";
import { getConfig } from "../src/env";
import { AUTH, base } from "./support/http";

const config = () => getConfig(env);

// The seeded publication's shape. The list is imported, grows in a continuous confirmed
// stream to today, and churns across four completed sends, so the mailable audience
// fluctuates 140 → 141 → 142 → 148 and settles at 155 today (156 confirmed, 1 of them suppressed). These
// are the numbers the lifecycle produces; they lock the "frozen at send time" behavior, so a
// regression is obvious.
const CONFIRMED = 156;
const PENDING = 3;
// Fifteen readers who left, one reader who complained, and the operator's own test address,
// unsubscribed after the test send as Verify it works has them do.
const UNSUBSCRIBED = 17;
// A bounce on a confirmed subscriber, plus a block on an unsubscribed and a pending address,
// which shadow no one.
const SUPPRESSED_CONFIRMED = 1;
const SUPPRESSED = 3;
const AUDIENCE_NOW = CONFIRMED - SUPPRESSED_CONFIRMED; // 155
const SENT_RECIPIENTS = [140, 141, 142, 148]; // oldest → newest
// Before them, the operator's email-only test send, to their own second address (SPEC §5).
const TEST_SUBJECT = "Test email";
const TOTAL_DELIVERIES = SENT_RECIPIENTS.reduce((a, b) => a + b, 1); // 572

/** The sends on the list's timeline, oldest first: every sent send but the test send. */
const timelineSends = async () =>
  (await listSends(env.DB))
    .filter((s) => s.status === "sent" && s.subject !== TEST_SUBJECT)
    .sort((a, b) => a.fire_at - b.fire_at);

/** Delivery rows for one send (email + any post-send event) — proves the record is real
 *  rows, not a summary count. */
async function deliveriesFor(sendId: string): Promise<{ email: string; event: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT email, event FROM deliveries WHERE send_id = ?")
    .bind(sendId)
    .all<{ email: string; event: string | null }>();
  return results;
}

// The tables a seed fills and a reset must empty, children first.
const RESET_TABLES = [
  "deliveries",
  "sends",
  "post_revisions",
  "posts",
  "suppressions",
  "subscribers",
  "settings",
];

async function rowCount(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("dev seed (Field Notes dataset)", () => {
  it("resets and loads a realistic, spec-valid dataset", async () => {
    const summary = await seedDatabase(env, config());

    // The demo ships a branded identity so the reader surface isn't the bare fallback,
    // and default test recipients so "Send test email" is pre-filled out of the box.
    const seededSettings = await getSettings(env.DB);
    expect(seededSettings.publication.name).toBe("Field Notes");
    expect(seededSettings.testRecipients).toEqual([
      "editor@fieldnotes.example",
      "proof@fieldnotes.example",
    ]);

    expect(summary.subscribers).toEqual({
      confirmed: CONFIRMED,
      pending: PENDING,
      unsubscribed: UNSUBSCRIBED,
    });
    expect(summary.suppressions).toBe(SUPPRESSED);
    expect(summary.audience).toBe(AUDIENCE_NOW); // confirmed − suppressed (SPEC §7)
    expect(summary.posts).toEqual({ sent: 5, scheduled: 1, draft: 2 });
    expect(summary.deliveries).toBe(TOTAL_DELIVERIES);

    const c = await counts(env.DB);
    expect(c).toEqual({
      confirmed: CONFIRMED,
      pending: PENDING,
      unsubscribed: UNSUBSCRIBED,
      suppressed: SUPPRESSED,
    });

    const audience = await audienceEmails(env.DB);
    expect(audience).toHaveLength(AUDIENCE_NOW);

    const sends = await listSends(env.DB);
    expect(sends.filter((s) => s.status === "sent")).toHaveLength(5);
    expect(sends.filter((s) => s.status === "scheduled")).toHaveLength(1);
    // The scheduled post fires in the future — a visible, cancelable window (I6) — and
    // targets today's list, distinct from the frozen historical audiences below.
    const scheduled = sends.find((s) => s.status === "scheduled")!;
    expect(scheduled.fire_at).toBeGreaterThan(Date.now());
    expect(scheduled.recipient_count).toBe(AUDIENCE_NOW);
  });

  it("puts a suppression on every consent state, and shows each reason for leaving (SPEC §7)", async () => {
    await seedDatabase(env, config());
    const { results } = await env.DB.prepare(
      `SELECT s.status, x.reason, x.detail, x.created_at, s.created_at AS joined
       FROM suppressions x JOIN subscribers s ON s.email = x.email ORDER BY s.status, x.reason`,
    ).all<{
      status: string;
      reason: string;
      detail: string | null;
      created_at: number;
      joined: number;
    }>();
    expect(results.map((r) => `${r.status}/${r.reason}`)).toEqual([
      "confirmed/bounce",
      "pending/manual",
      "unsubscribed/manual",
    ]);
    const { results: causes } = await env.DB.prepare(
      "SELECT status, unsubscribe_cause AS cause, COUNT(*) AS n FROM subscribers WHERE unsubscribe_cause IS NOT NULL GROUP BY status, cause ORDER BY status, cause",
    ).all<{ status: string; cause: string; n: number }>();
    expect(causes.map((r) => `${r.status}/${r.cause}`)).toEqual([
      "pending/erased",
      "unsubscribed/complaint",
      "unsubscribed/reader",
    ]);
    // The erased person who signed up again left before the sign-up that came after it.
    const returning = await env.DB.prepare(
      "SELECT created_at, unsubscribed_at FROM subscribers WHERE unsubscribe_cause = 'erased'",
    ).first<{ created_at: number; unsubscribed_at: number }>();
    expect(returning!.unsubscribed_at).toBeLessThan(returning!.created_at);
    // A block by hand comes after the unsubscribe it follows, and nothing is dated ahead.
    const blocked = await env.DB.prepare(
      `SELECT x.created_at, s.unsubscribed_at FROM suppressions x
       JOIN subscribers s ON s.email = x.email WHERE s.status = 'unsubscribed'`,
    ).first<{ created_at: number; unsubscribed_at: number }>();
    expect(blocked!.created_at).toBeGreaterThan(blocked!.unsubscribed_at);
    for (const r of results) {
      expect(r.created_at).toBeLessThanOrEqual(Date.now());
    }
  });

  it("freezes each send's audience as it was AT THAT MOMENT, not the final list", async () => {
    await seedDatabase(env, config());

    const sent = await timelineSends(); // chronological

    // The audience grew and churned between sends, so the recipient counts differ from
    // each other and from today's mailable list.
    expect(sent.map((s) => s.recipient_count)).toEqual(SENT_RECIPIENTS);
    for (const s of sent) {
      expect(s.recipient_count).not.toBe(AUDIENCE_NOW);
    }

    // Each recipient count is backed by exactly that many real delivery rows — not just
    // a summary number on the send.
    for (let i = 0; i < sent.length; i++) {
      const rows = await deliveriesFor(sent[i]!.id);
      expect(rows).toHaveLength(SENT_RECIPIENTS[i]!);
    }

    const nowMailable = new Set(await audienceEmails(env.DB));

    // Someone who unsubscribed after the first post was still mailed by it: the oldest send's
    // record retains addresses that are no longer in the current audience (I2 is about
    // future sends, not rewriting the past).
    const firstEmails = (await deliveriesFor(sent[0]!.id)).map((r) => r.email);
    expect(firstEmails.some((e) => !nowMailable.has(e))).toBe(true);

    // The bounce and complaint on the second post take those two addresses out of the current
    // audience, one suppressed and one unsubscribed, yet they remain in its delivery record,
    // carrying the event that took them out.
    const secondRows = await deliveriesFor(sent[1]!.id);
    const shadowed = secondRows.filter((r) => r.event === "bounced" || r.event === "complained");
    expect(shadowed).toHaveLength(2);
    for (const r of shadowed) {
      expect(nowMailable.has(r.email)).toBe(false);
    }

    // Unsubscribes trickle in after each post rather than firing at a few shared
    // instants: the churn timestamps are dispersed, not batched into three moments.
    const { results: unsubbed } = await env.DB.prepare(
      "SELECT unsubscribed_at FROM subscribers WHERE status = 'unsubscribed'",
    ).all<{ unsubscribed_at: number }>();
    expect(unsubbed).toHaveLength(UNSUBSCRIBED);
    const distinctUnsubTimes = new Set(unsubbed.map((r) => r.unsubscribed_at));
    expect(distinctUnsubTimes.size).toBeGreaterThanOrEqual(UNSUBSCRIBED - 1);
  });

  it("reset wipes the database back to a fresh install (the reverse of seed)", async () => {
    await seedDatabase(env, config());
    // The seed's own identity is what the reset has to clear, and every table has rows.
    expect((await getSettings(env.DB)).publication.name).toBe("Field Notes");
    for (const table of RESET_TABLES) {
      expect(await rowCount(table), table).toBeGreaterThan(0);
    }

    const res = await SELF.fetch(`${base}/api/dev/reset`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);

    for (const table of RESET_TABLES) {
      expect(await rowCount(table), table).toBe(0);
    }
    expect(await counts(env.DB)).toEqual({
      confirmed: 0,
      pending: 0,
      unsubscribed: 0,
      suppressed: 0,
    });
    expect(await listSends(env.DB)).toHaveLength(0);
    // Settings are back to defaults, so the identity falls back to the From name.
    const after = (await (await SELF.fetch(`${base}/api/settings`, { headers: AUTH })).json()) as {
      settings: { publication: { name: string } };
    };
    expect(after.settings.publication.name).toBe("");
  });

  it("serves a seeded sent post's frozen render at its archive URL, cover ref intact", async () => {
    await seedDatabase(env, config());
    const res = await SELF.fetch(`${base}/archive/the-hovering-hunter`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("The hovering hunter");
    // The cover image resolves to the R2-served media URL (bytes land via the route).
    expect(body).toContain("/media/posts/5eed0002-0000-4000-8000-000000000002/kestrel.webp");
    expect(body).not.toContain("%%UNSUBSCRIBE_URL%%");
  });

  it("starts with the operator's email-only test send: to their own address alone, before the list came in, and in no public list (SPEC §5)", async () => {
    await seedDatabase(env, config());
    const sends = (await listSends(env.DB)).sort((a, b) => a.fire_at - b.fire_at);
    const test = sends[0]!;
    expect(test.subject).toBe(TEST_SUBJECT);
    expect(test.status).toBe("sent");
    expect(test.recipient_count).toBe(1);
    expect((await deliveriesFor(test.id)).map((r) => r.email)).toEqual([
      "proof@fieldnotes.example",
    ]);
    const post = await env.DB.prepare("SELECT email_only FROM posts WHERE id = ?")
      .bind(test.post_id)
      .first<{ email_only: number }>();
    expect(post?.email_only).toBe(1);
    // Every other post is listed, as a publication's are.
    const listed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE email_only = 0",
    ).first<{ n: number }>();
    expect(listed?.n).toBe(7);
    // The test address joined and left around the test, so it is in no later audience.
    const proof = await env.DB.prepare(
      "SELECT status, confirmed_at, unsubscribed_at FROM subscribers WHERE email = ?",
    )
      .bind("proof@fieldnotes.example")
      .first<{ status: string; confirmed_at: number; unsubscribed_at: number }>();
    expect(proof?.status).toBe("unsubscribed");
    expect(proof!.confirmed_at).toBeLessThan(test.fire_at);
    expect(proof!.unsubscribed_at).toBeLessThan(sends[1]!.fire_at);
    // Its page answers at the email's unlisted link, unindexed; it never had an archive
    // address, and the lists leave it out.
    const token = await env.DB.prepare("SELECT unlisted_token FROM posts WHERE id = ?")
      .bind(test.post_id)
      .first<string>("unlisted_token");
    const page = await SELF.fetch(`${base}/email/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect((await SELF.fetch(`${base}/archive/test-email`)).status).toBe(404);
    for (const path of ["/archive", "/"]) {
      expect(await (await SELF.fetch(`${base}${path}`)).text(), path).not.toContain(TEST_SUBJECT);
    }
  });

  it("keeps drafts and the scheduled post out of the public archive", async () => {
    await seedDatabase(env, config());
    for (const slug of ["try-editing-this-draft", "a-quick-note"]) {
      const res = await SELF.fetch(`${base}/archive/${slug}`);
      expect(res.status).toBe(404);
    }
  });

  it("is idempotent — re-seeding resets and reloads to the same counts", async () => {
    await seedDatabase(env, config());
    const summary = await seedDatabase(env, config());
    expect(summary.posts).toEqual({ sent: 5, scheduled: 1, draft: 2 });
    expect(summary.deliveries).toBe(TOTAL_DELIVERIES);
    const c = await counts(env.DB);
    expect(c).toEqual({
      confirmed: CONFIRMED,
      pending: PENDING,
      unsubscribed: UNSUBSCRIBED,
      suppressed: SUPPRESSED,
    });
  });

  it("re-seeding resets the settings singleton, dropping stale operator config", async () => {
    // An operator whose saved template predates the Hugo-style placeholder names (it
    // still uses post.body and email.unsubscribeUrl), plus a custom identity. resetAll clears settings, and the seed
    // re-populates only the demo's own — so a re-seed can't carry the stale row forward.
    await updateSettings(env.DB, {
      publication: { name: "Old Name" },
      email_template:
        '<div>{{ post.body }}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>',
    });
    await seedDatabase(env, config());
    const s = await getSettings(env.DB);
    expect(s.emailTemplate).toBe(""); // back to the built-in default
    expect(s.publication.name).toBe("Field Notes"); // the demo's identity, not the old one
  });
});
