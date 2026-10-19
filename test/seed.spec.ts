import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listSends } from "../src/db/sends";
import { getSettings, updateSettings } from "../src/db/settings";
import { audienceEmails, counts, isSuppressed } from "../src/db/subscribers";
import { seedDatabase } from "../src/dev/seed";
import { getConfig } from "../src/env";
import { AUTH, base } from "./support/http";

const config = () => getConfig(env);

// The seeded publication's shape. Half the list is imported, the rest signs up in a continuous
// confirmed stream to today, and it churns across four completed sends, so the mailable audience
// grows 83 → 103 → 120 → 141 and settles at 158 today (159 confirmed, 1 of them suppressed). These
// are the numbers the lifecycle produces; they lock the "frozen at send time" behavior, so a
// regression is obvious.
const CONFIRMED = 159;
const PENDING = 3;
// Fifteen readers who left (one of them on request, one later erased), one reader who
// complained, one who left while post #4 went out, one the import says left elsewhere, and the
// operator's own test address, unsubscribed after the test send as Verify it works has them do.
const UNSUBSCRIBED = 19;
// A bounce on a confirmed subscriber, plus a block on an unsubscribed and a pending address,
// which shadow no one: the subscribers the list counts as suppressed.
const SUPPRESSED_CONFIRMED = 1;
const SUPPRESSED = 3;
// And two suppressions with no subscriber: a bounce the import brought, and a blocked role address.
const SUPPRESSIONS = SUPPRESSED + 2;
const AUDIENCE_NOW = CONFIRMED - SUPPRESSED_CONFIRMED; // 158
const SENT_RECIPIENTS = [83, 103, 120, 141]; // oldest → newest
// Before them, the operator's email-only test send, to their own second address (SPEC §5).
const TEST_SUBJECT = "Test email";
const TOTAL_DELIVERIES = SENT_RECIPIENTS.reduce((a, b) => a + b, 1); // 448

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
  "imports",
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
    expect(summary.suppressions).toBe(SUPPRESSIONS);
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
      `SELECT COALESCE(s.status, 'none') AS status, x.reason, x.detail, x.created_at, s.created_at AS joined
       FROM suppressions x LEFT JOIN subscribers s ON s.email = x.email ORDER BY status, x.reason`,
    ).all<{
      status: string;
      reason: string;
      detail: string | null;
      created_at: number;
      joined: number | null;
    }>();
    // On each consent state, and on an address that never subscribed: a bounce the import
    // brought, and a role address the publisher blocked.
    expect(results.map((r) => `${r.status}/${r.reason}`)).toEqual([
      "confirmed/bounce",
      "none/import_bounce",
      "none/manual",
      "pending/manual",
      "unsubscribed/manual",
    ]);
    // Every suppression says why, and a block says it in the publisher's own words.
    expect(results.every((r) => r.detail !== null && r.detail !== "")).toBe(true);
    const { results: causes } = await env.DB.prepare(
      "SELECT status, unsubscribe_cause AS cause, COUNT(*) AS n FROM subscribers WHERE unsubscribe_cause IS NOT NULL GROUP BY status, cause ORDER BY status, cause",
    ).all<{ status: string; cause: string; n: number }>();
    expect(causes.map((r) => `${r.status}/${r.cause}/${r.n}`)).toEqual([
      "pending/erased/1",
      "unsubscribed/complaint/1",
      "unsubscribed/erased/1",
      "unsubscribed/import/1",
      "unsubscribed/publisher/1",
      "unsubscribed/reader/15",
    ]);
    // The erased person who signed up again left before the sign-up that came after it.
    const returning = await env.DB.prepare(
      "SELECT created_at, unsubscribed_at FROM subscribers WHERE unsubscribe_cause = 'erased' AND status = 'pending'",
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

  it("brings the list in by one import, whose record each imported subscriber names (SPEC §7, §8)", async () => {
    await seedDatabase(env, config());
    const { results: imports } = await env.DB.prepare(
      "SELECT id, created_at, principal_kind, principal_email, attestation_version, file_name, counts, suppressions_added FROM imports",
    ).all<{
      id: string;
      created_at: number;
      principal_kind: string;
      principal_email: string;
      attestation_version: number;
      file_name: string;
      counts: string;
      suppressions_added: number;
    }>();
    expect(imports).toHaveLength(1);
    const record = imports[0]!;
    expect(record).toMatchObject({
      principal_kind: "human",
      principal_email: "editor@fieldnotes.example",
      attestation_version: 1,
      file_name: "sendy-export.csv",
      suppressions_added: 1,
    });
    expect(JSON.parse(record.counts)).toMatchObject({
      added_confirmed: 80,
      added_unsubscribed: 1,
      suppressed: 1,
    });
    // Every imported subscriber was added when the import was committed, says where and how
    // they opted in and the file's evidence, and kept the file's own confirmation date.
    const { results: imported } = await env.DB.prepare(
      "SELECT status, created_at, confirmed_at, origin, opt_in, consent_evidence FROM subscribers WHERE import_id = ?",
    )
      .bind(record.id)
      .all<{
        status: string;
        created_at: number;
        confirmed_at: number | null;
        origin: string;
        opt_in: string;
        consent_evidence: string;
      }>();
    // The 80 the file added confirmed, less the one later erased, and the one it says left.
    expect(imported).toHaveLength(80);
    for (const s of imported) {
      expect(s.created_at).toBe(record.created_at);
      expect(s.origin).toBe("sendy");
      expect(["double", "single"]).toContain(s.opt_in);
      expect(Object.keys(JSON.parse(s.consent_evidence))).toEqual(["signup_ip", "form"]);
      if (s.confirmed_at !== null) {
        expect(s.confirmed_at).toBeLessThan(record.created_at);
      }
    }
    expect(new Set(imported.map((s) => s.opt_in))).toEqual(new Set(["double", "single"]));
  });

  it("shows on the records an erased recipient, a soft bounce, and a skipped reader (SPEC §7, §8)", async () => {
    await seedDatabase(env, config());
    const sent = await timelineSends();
    const rowsOf = async (i: number) =>
      (
        await env.DB.prepare(
          "SELECT email, status, event, bounce_kind FROM deliveries WHERE send_id = ?",
        )
          .bind(sent[i]!.id)
          .all<{
            email: string;
            status: string;
            event: string | null;
            bounce_kind: string | null;
          }>()
      ).results;
    // Erased after post #3: posts #1 to #3 each hold one placeholder in their place, the same
    // one, and post #4 never had them.
    const placeholders = await Promise.all(
      [0, 1, 2, 3].map(async (i) =>
        (await rowsOf(i)).filter((r) => r.email.startsWith("erased:")).map((r) => r.email),
      ),
    );
    expect(placeholders.map((p) => p.length)).toEqual([1, 1, 1, 0]);
    expect(new Set(placeholders.flat()).size).toBe(1);
    const erased = await env.DB.prepare(
      "SELECT unsub_token, origin, import_id FROM subscribers WHERE status = 'unsubscribed' AND unsubscribe_cause = 'erased'",
    ).first();
    expect(erased).toEqual({ unsub_token: null, origin: null, import_id: null });
    // A full mailbox on post #3: a soft bounce, which suppresses no one.
    const soft = (await rowsOf(2)).filter((r) => r.bounce_kind === "soft");
    expect(soft).toHaveLength(1);
    expect(await isSuppressed(env.DB, soft[0]!.email)).toBe(false);
    // A reader who left while post #4 went out: skipped, and unsubscribed today.
    const skipped = (await rowsOf(3)).filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(1);
    const leaver = await env.DB.prepare("SELECT status FROM subscribers WHERE email = ?")
      .bind(skipped[0]!.email)
      .first<{ status: string }>();
    expect(leaver!.status).toBe("unsubscribed");
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
