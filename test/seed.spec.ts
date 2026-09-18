import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listSends } from "../src/db/sends";
import { getSettings, updateSettings } from "../src/db/settings";
import { audienceEmails, counts } from "../src/db/subscribers";
import { seedDatabase } from "../src/dev/seed";
import { getConfig } from "../src/env";
import { adminAuth } from "./support/auth";

const base = "https://kestrel.test";
const config = () => getConfig(env);

// The seeded publication's shape. The list is imported, grows in a continuous confirmed
// stream to today, and churns across three completed sends, so the mailable audience
// fluctuates 140 → 147 → 151 and settles at 155 today (157 confirmed − 2 suppressed). These
// are the numbers the lifecycle produces; they lock the "frozen at send time" behavior, so a
// regression is obvious.
const CONFIRMED = 157;
const PENDING = 3;
const UNSUBSCRIBED = 15;
const SUPPRESSED = 2;
const AUDIENCE_NOW = CONFIRMED - SUPPRESSED; // 155
const SENT_RECIPIENTS = [140, 147, 151]; // oldest → newest
const TOTAL_DELIVERIES = SENT_RECIPIENTS.reduce((a, b) => a + b, 0); // 438

/** Delivery rows for one send (email + any post-send event) — proves the record is real
 *  rows, not a summary count. */
async function deliveriesFor(sendId: string): Promise<{ email: string; event: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT email, event FROM deliveries WHERE send_id = ?")
    .bind(sendId)
    .all<{ email: string; event: string | null }>();
  return results;
}

describe("dev seed (Windbreak dataset)", () => {
  it("resets and loads a realistic, spec-valid dataset", async () => {
    const summary = await seedDatabase(env, config());

    // The demo ships a branded identity so the reader surface isn't the bare fallback,
    // and default test recipients so "Send test email" is pre-filled out of the box.
    const seededSettings = await getSettings(env.DB);
    expect(seededSettings.publication.name).toBe("Windbreak");
    expect(seededSettings.testRecipients).toEqual([
      "editor@windbreak.example",
      "proof@windbreak.example",
    ]);

    expect(summary.subscribers).toEqual({
      confirmed: CONFIRMED,
      pending: PENDING,
      unsubscribed: UNSUBSCRIBED,
    });
    expect(summary.suppressions).toBe(SUPPRESSED);
    expect(summary.audience).toBe(AUDIENCE_NOW); // confirmed − suppressed (I1)
    expect(summary.posts).toEqual({ sent: 3, scheduled: 1, draft: 2 });
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
    expect(sends.filter((s) => s.status === "sent")).toHaveLength(3);
    expect(sends.filter((s) => s.status === "scheduled")).toHaveLength(1);
    // The scheduled post fires in the future — a visible, cancelable window (I6) — and
    // targets today's list, distinct from the frozen historical audiences below.
    const scheduled = sends.find((s) => s.status === "scheduled")!;
    expect(scheduled.fire_at).toBeGreaterThan(Date.now());
    expect(scheduled.recipient_count).toBe(AUDIENCE_NOW);
  });

  it("freezes each send's audience as it was AT THAT MOMENT, not the final list", async () => {
    await seedDatabase(env, config());

    const sent = (await listSends(env.DB))
      .filter((s) => s.status === "sent")
      .sort((a, b) => a.fire_at - b.fire_at); // chronological

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

    // Someone who unsubscribed after issue #1 was still mailed by it: the oldest send's
    // record retains addresses that are no longer in the current audience (I2 is about
    // future sends, not rewriting the past).
    const firstEmails = (await deliveriesFor(sent[0]!.id)).map((r) => r.email);
    expect(firstEmails.some((e) => !nowMailable.has(e))).toBe(true);

    // The bounce and complaint on issue #2 shadow those two confirmed addresses out of
    // the current audience — yet they remain in #2's delivery record, carrying the event
    // that produced their suppression.
    const secondRows = await deliveriesFor(sent[1]!.id);
    const shadowed = secondRows.filter((r) => r.event === "bounced" || r.event === "complained");
    expect(shadowed).toHaveLength(SUPPRESSED);
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
    // Set an identity so we can prove the settings singleton resets too.
    await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { ...(await adminAuth()), "content-type": "application/json" },
      body: JSON.stringify({ publication: { name: "Windbreak" } }),
    });

    const res = await SELF.fetch(`${base}/api/dev/reset`, {
      method: "POST",
      headers: { ...(await adminAuth()) },
    });
    expect(res.status).toBe(200);

    expect(await counts(env.DB)).toEqual({
      confirmed: 0,
      pending: 0,
      unsubscribed: 0,
      suppressed: 0,
    });
    expect(await listSends(env.DB)).toHaveLength(0);
    // Settings are back to defaults, so the identity falls back to the From name.
    const after = (await (
      await SELF.fetch(`${base}/api/settings`, { headers: await adminAuth() })
    ).json()) as { settings: { publication: { name: string } } };
    expect(after.settings.publication.name).toBe("");
  });

  it("serves a seeded sent post's frozen render at its archive URL, cover ref intact", async () => {
    await seedDatabase(env, config());
    const res = await SELF.fetch(`${base}/archive/the-hovering-hunter`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("The hovering hunter");
    // The cover image resolves to the R2-served media URL (bytes land via the route).
    expect(body).toContain("/media/posts/5eed0001-0000-4000-8000-000000000001/kestrel.jpg");
    expect(body).not.toContain("%%UNSUBSCRIBE_URL%%");
  });

  it("keeps drafts and the scheduled post out of the public archive", async () => {
    await seedDatabase(env, config());
    for (const slug of ["the-secret-life-of-robins", "waxwings-and-fieldfares"]) {
      const res = await SELF.fetch(`${base}/archive/${slug}`);
      expect(res.status).toBe(404);
    }
  });

  it("is idempotent — re-seeding resets and reloads to the same counts", async () => {
    await seedDatabase(env, config());
    const summary = await seedDatabase(env, config());
    expect(summary.posts).toEqual({ sent: 3, scheduled: 1, draft: 2 });
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
    // An operator whose saved template predates the email.* token migration (it still
    // uses footer.*), plus a custom identity. resetAll clears settings, and the seed
    // re-populates only the demo's own — so a re-seed can't carry the stale row forward.
    await updateSettings(env.DB, {
      publication: { name: "Old Name" },
      emailTemplate:
        '<div>{{ post.body }}<a href="{{ footer.unsubscribeUrl }}">Unsubscribe</a></div>',
    });
    await seedDatabase(env, config());
    const s = await getSettings(env.DB);
    expect(s.emailTemplate).toBe(""); // back to the built-in email.* default
    expect(s.publication.name).toBe("Windbreak"); // the demo's identity, not the old one
  });
});
