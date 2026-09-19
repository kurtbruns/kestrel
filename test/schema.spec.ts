import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("schema (0001_init + 0002_template_revisions)", () => {
  it("creates all eight tables", async () => {
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
      "template_revisions",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("sends carry the template revision they were made with (nullable for the baseline's sake)", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(sends)").all<{
      name: string;
      notnull: number;
    }>();
    const col = results.find((c) => c.name === "template_revision");
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(0);
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

  it("enforces one active send per post via the partial unique index", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES ('p2','p-2','scheduled',?,?)",
    )
      .bind(now, now)
      .run();
    const insertSend = (id: string, status: string) =>
      env.DB.prepare(
        "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, 'p2', ?, ?, '', '', '', ?)",
      )
        .bind(id, status, now, now)
        .run();

    await insertSend("sd1", "scheduled");
    // A second active send (scheduled or sending) for the same post is rejected.
    await expect(insertSend("sd2", "scheduled")).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insertSend("sd3", "sending")).rejects.toThrow(/UNIQUE constraint failed/);

    // Terminal states fall outside the predicate — many are allowed to coexist,
    // and once the active send leaves the active set a re-schedule is unblocked.
    await insertSend("sd4", "canceled");
    await env.DB.prepare("UPDATE sends SET status = 'sent' WHERE id = 'sd1'").run();
    await insertSend("sd6", "scheduled"); // the post is active-send-free again
  });
});
