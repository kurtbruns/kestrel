import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listSends } from "../src/db/sends";
import { addSuppression, audienceEmails, counts, isSuppressed } from "../src/db/subscribers";
import {
  buildScaledAudience,
  buildTimeline,
  makePrng,
  parseSeedSize,
  scaledEmailFor,
  seedDatabase,
} from "../src/dev/seed";
import { getConfig } from "../src/env";
import { seedConfirmed } from "./support/fixtures";

// The parametric seed: a `size` selects a PRNG-driven list scaled to an
// approximate target, while the default (no size) keeps the curated Field Notes dataset
// unchanged (guarded in detail by seed.spec.ts). These tests lock the pieces the scale
// depends on — a reproducible PRNG, a collision-free email generator that reaches 100k,
// and a lifecycle that still fluctuates and keeps low outcome rates at scale.

const config = () => getConfig(env);

// A fixed clock for the in-memory builds, so a run on any date builds the same timeline.
const EPOCH = 1_700_000_000_000;

describe("parseSeedSize", () => {
  it("maps size tokens to counts, capped at 100k", () => {
    expect(parseSeedSize("100")).toBe(100);
    expect(parseSeedSize("1k")).toBe(1000);
    expect(parseSeedSize("10k")).toBe(10_000);
    expect(parseSeedSize("100k")).toBe(100_000);
    expect(parseSeedSize("1000")).toBe(1000);
    expect(parseSeedSize(" 2K ")).toBe(2000);
    expect(parseSeedSize("500000")).toBe(100_000); // capped at 100k
  });

  it("returns undefined for an absent or unparseable value (→ the curated dataset)", () => {
    expect(parseSeedSize(null)).toBeUndefined();
    expect(parseSeedSize(undefined)).toBeUndefined();
    expect(parseSeedSize("")).toBeUndefined();
    expect(parseSeedSize("lots")).toBeUndefined();
    expect(parseSeedSize("-5")).toBeUndefined();
    expect(parseSeedSize("1.5k")).toBeUndefined();
  });
});

describe("makePrng", () => {
  it("is reproducible for a seed and diverges across seeds", () => {
    const seq = (seed: number) => {
      const rand = makePrng(seed);
      return Array.from({ length: 8 }, () => rand());
    };
    const a = seq(1);
    expect(seq(1)).toEqual(a); // same seed → same stream
    expect(seq(2)).not.toEqual(a);
    for (const x of a) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("scaledEmailFor", () => {
  const LOCAL = /^[a-z]+[._][a-z]+$/; // two whole name tokens, one separator, no digits
  const DOMAIN = /^(example\.(?:com|net|org)|(?:mail|post|inbox)\.example)$/; // reserved only

  it("produces unique, human-plausible, suffix-free addresses across the whole 100k range", () => {
    const N = 100_000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) {
      const [local, domain] = scaledEmailFor(i).split("@");
      // No numeric suffix anywhere below the cap: the address space exceeds 100k, so the
      // generator never has to fall back to a counter (the old "loop and repeat").
      expect(LOCAL.test(local!)).toBe(true);
      expect(DOMAIN.test(domain!)).toBe(true);
      seen.add(`${local}@${domain}`);
    }
    expect(seen.size).toBe(N); // every address is unique — the scramble is a bijection
  });

  it("varies name, format, and domain across consecutive indices (no visible cycle)", () => {
    const locals = Array.from({ length: 64 }, (_, i) => scaledEmailFor(i).split("@")[0]!);
    const domains = Array.from({ length: 64 }, (_, i) => scaledEmailFor(i).split("@")[1]!);
    // Both separators and more than one domain show up — not one monotonous format.
    expect(locals.some((l) => l.includes("."))).toBe(true);
    expect(locals.some((l) => l.includes("_"))).toBe(true);
    expect(new Set(domains).size).toBeGreaterThan(1);
    // No two adjacent rows share a name pair (order-independent), so nothing reads as a loop.
    const nameKey = (l: string) => l.split(/[._]/).sort().join("+");
    for (let i = 1; i < locals.length; i++) {
      expect(nameKey(locals[i]!)).not.toBe(nameKey(locals[i - 1]!));
    }
  });
});

describe("buildScaledAudience", () => {
  it("scales the lifecycle: unique roster, fluctuating sends, low outcome rates", () => {
    const t = buildTimeline(EPOCH);
    const built = buildScaledAudience(t, 10_000, makePrng(1));

    // Every address across the whole roster is unique.
    const emails = built.subscribers.map((s) => s.email);
    expect(new Set(emails).size).toBe(emails.length);

    // Confirmed-now lands near the requested target — approximate and PRNG-jittered, so
    // the count reads organic (not exactly 10,000) while staying in a believable band.
    const confirmed = built.subscribers.filter((s) => s.status === "confirmed").length;
    expect(confirmed).toBeGreaterThan(8_500);
    expect(confirmed).toBeLessThan(11_500);
    expect(confirmed).not.toBe(10_000); // organic — not the exact round target

    // The four frozen audiences fluctuate — none equal, all non-empty.
    const sizes = built.sentAudiences.map((audience) => audience.length);
    expect(sizes).toHaveLength(4);
    expect(Math.min(...sizes)).toBeGreaterThan(0);
    expect(new Set(sizes).size).toBe(4);

    // Suppressions stay a small fraction of the list (a realistic bounce+complaint rate).
    expect(built.suppressions.length).toBeGreaterThanOrEqual(2);
    expect(built.suppressions.length).toBeLessThan(confirmed * 0.02);
    // The second send's events mirror the suppressions that shadow the current audience.
    expect(built.sendTwoEvents.size).toBe(built.suppressions.length);
  });

  it("is reproducible for a (size, seed) and varies the churn timing across seeds", () => {
    const t = buildTimeline(EPOCH);
    const unsubTimes = (seed: number) =>
      buildScaledAudience(t, 5_000, makePrng(seed)).subscribers.map((s) => s.unsubscribed_at);
    const victims = (seed: number) =>
      buildScaledAudience(t, 5_000, makePrng(seed))
        .suppressions.map((x) => x.email)
        .sort();

    expect(unsubTimes(1)).toEqual(unsubTimes(1)); // same seed → identical churn timing
    expect(victims(1)).toEqual(victims(1)); // and identical suppression victims
    expect(unsubTimes(2)).not.toEqual(unsubTimes(1)); // a different seed disperses them elsewhere
  });
});

/** What the database holds after a seed, read back table by table rather than taken from
 *  the summary the seed returns. */
async function stored() {
  const { results: posts } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM posts GROUP BY status",
  ).all<{ status: string; n: number }>();
  const { results: sentDeliveries } = await env.DB.prepare(
    `SELECT s.recipient_count AS recipients, COUNT(d.email) AS rows FROM sends s
     LEFT JOIN deliveries d ON d.send_id = s.id WHERE s.status = 'sent'
     GROUP BY s.id ORDER BY s.fire_at`,
  ).all<{ recipients: number; rows: number }>();
  const deliveries = await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first<{
    n: number;
  }>();
  return {
    posts: Object.fromEntries(posts.map((p) => [p.status, p.n])),
    counts: await counts(env.DB),
    audience: (await audienceEmails(env.DB)).length,
    sentDeliveries,
    deliveries: deliveries?.n,
  };
}

describe("dev seed — scaled (parametric, DB-backed)", () => {
  it("loads a spec-valid scaled dataset and is idempotent", async () => {
    const summary = await seedDatabase(env, config(), undefined, undefined, { size: 100, seed: 7 });

    // The summary is what the seed meant to write; everything below reads back what it did.
    const loaded = await stored();
    expect(loaded.posts).toEqual({ sent: 4, scheduled: 1, draft: 2 });
    expect(summary.posts).toEqual(loaded.posts);
    const { suppressed, ...subscribers } = loaded.counts;
    expect(subscribers).toEqual(summary.subscribers);
    expect(suppressed).toBe(summary.suppressions);
    // Confirmed-now ≈ the requested 100 (PRNG-jittered so it reads organic, not exactly 100).
    expect(loaded.counts.confirmed).toBeGreaterThan(80);
    expect(loaded.counts.confirmed).toBeLessThan(120);
    // The current audience is confirmed − suppressed (SPEC §7), read from the list itself.
    expect(suppressed).toBeGreaterThanOrEqual(2);
    expect(loaded.audience).toBe(loaded.counts.confirmed - suppressed);
    expect(summary.audience).toBe(loaded.audience);

    const sent = (await listSends(env.DB))
      .filter((s) => s.status === "sent")
      .sort((x, y) => x.fire_at - y.fire_at);
    expect(sent).toHaveLength(4);
    const recipients = sent.map((s) => s.recipient_count);
    // The frozen audiences fluctuate (not all equal) and differ from today's list. At this
    // small size two of the four can coincide by chance, so require ≥2 distinct here; the
    // 10k unit test above asserts all four differ, where there's room for it.
    expect(new Set(recipients).size).toBeGreaterThanOrEqual(2);
    for (const r of recipients) {
      expect(r).not.toBe(loaded.audience);
    }
    // Every recipient count is backed by exactly that many delivery rows on its own send.
    expect(loaded.sentDeliveries).toEqual(recipients.map((n) => ({ recipients: n, rows: n })));
    expect(loaded.deliveries).toBe(recipients.reduce((x, y) => x + y, 0));
    expect(summary.deliveries).toBe(loaded.deliveries);

    // A re-seed starts from empty: rows the first load never wrote don't survive it, and the
    // same (size, seed) writes the same dataset again rather than a second copy beside it.
    await seedConfirmed("stray@example.com");
    await addSuppression(env.DB, "stray-suppressed@example.com", "manual");
    await seedDatabase(env, config(), undefined, undefined, { size: 100, seed: 7 });
    const stray = await env.DB.prepare("SELECT 1 FROM subscribers WHERE email = ?")
      .bind("stray@example.com")
      .first();
    expect(stray).toBeNull();
    expect(await isSuppressed(env.DB, "stray-suppressed@example.com")).toBe(false);
    expect(await stored()).toEqual(loaded);
  });

  it("leaves the default (unsized) seed unchanged", async () => {
    const summary = await seedDatabase(env, config());
    // The curated list's signature numbers — the two-path contract's default half.
    expect(summary.subscribers.confirmed).toBe(157);
    expect(summary.suppressions).toBe(2);
    expect(summary.audience).toBe(155);
  });
});
