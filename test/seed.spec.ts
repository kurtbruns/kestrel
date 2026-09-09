import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listSends } from "../src/db/sends";
import { audienceEmails, counts } from "../src/db/subscribers";
import { seedDatabase } from "../src/dev/seed";
import { getConfig } from "../src/env";

const base = "https://kestrel.test";
const config = () => getConfig(env);

describe("dev seed (Field Notes dataset)", () => {
  it("resets and loads a realistic, spec-valid dataset", async () => {
    const summary = await seedDatabase(env, config());

    expect(summary.subscribers).toEqual({ confirmed: 50, pending: 4, unsubscribed: 3 });
    expect(summary.suppressions).toBe(2);
    expect(summary.audience).toBe(49); // 50 confirmed − 1 suppressed-confirmed (I1)
    expect(summary.posts).toEqual({ sent: 3, scheduled: 1, draft: 2 });
    expect(summary.deliveries).toBe(49 * 3);

    const c = await counts(env.DB);
    expect(c).toEqual({ confirmed: 50, pending: 4, unsubscribed: 3, suppressed: 2 });

    const audience = await audienceEmails(env.DB);
    expect(audience).toHaveLength(49);

    const sends = await listSends(env.DB);
    expect(sends.filter((s) => s.status === "sent")).toHaveLength(3);
    expect(sends.filter((s) => s.status === "scheduled")).toHaveLength(1);
    // The scheduled issue fires in the future — a visible, cancelable window (I6).
    const scheduled = sends.find((s) => s.status === "scheduled")!;
    expect(scheduled.fire_at).toBeGreaterThan(Date.now());
  });

  it("serves a seeded sent issue's frozen render at its archive URL, cover ref intact", async () => {
    await seedDatabase(env, config());
    const res = await SELF.fetch(`${base}/newsletter/the-hovering-hunter`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("The hovering hunter");
    // The cover image resolves to the R2-served media URL (bytes land via the route).
    expect(body).toContain("/media/posts/5eed0001-0000-4000-8000-000000000001/kestrel.jpg");
    expect(body).not.toContain("%%UNSUBSCRIBE_URL%%");
  });

  it("keeps drafts and the scheduled issue out of the public archive", async () => {
    await seedDatabase(env, config());
    for (const slug of ["the-secret-life-of-robins", "waxwings-and-fieldfares"]) {
      const res = await SELF.fetch(`${base}/newsletter/${slug}`);
      expect(res.status).toBe(404);
    }
  });

  it("is idempotent — re-seeding resets and reloads to the same counts", async () => {
    await seedDatabase(env, config());
    const summary = await seedDatabase(env, config());
    expect(summary.posts).toEqual({ sent: 3, scheduled: 1, draft: 2 });
    const c = await counts(env.DB);
    expect(c).toEqual({ confirmed: 50, pending: 4, unsubscribed: 3, suppressed: 2 });
  });
});
