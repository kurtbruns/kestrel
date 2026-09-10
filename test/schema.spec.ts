import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("schema (0001_init)", () => {
  it("creates all seven tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of [
      "posts",
      "post_revisions",
      "images",
      "subscribers",
      "suppressions",
      "sends",
      "deliveries",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("enforces the subscribers.email unique constraint", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
    )
      .bind("s1", "a@example.com", "cfm1", "uns1", now)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
      )
        .bind("s2", "a@example.com", "cfm2", "uns2", now)
        .run(),
    ).rejects.toThrow();
  });

  it("enforces UNIQUE(send_id, email) on deliveries (idempotency backbone)", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES ('p1','p-1','draft',?,?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('sn1','p1','scheduled',?, '', '', '', ?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO deliveries (id, send_id, email, status, updated_at) VALUES ('d1','sn1','x@example.com','pending',?)",
    )
      .bind(now)
      .run();

    // INSERT OR IGNORE is a no-op on the dup (this is what makes resume safe).
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries (id, send_id, email, status, updated_at) VALUES ('d2','sn1','x@example.com','pending',?)",
    )
      .bind(now)
      .run();
    expect(res.meta.changes).toBe(0);
  });
});
