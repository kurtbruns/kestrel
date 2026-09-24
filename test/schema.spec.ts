import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("schema (0001_init)", () => {
  it("creates all nine tables", async () => {
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
      "settings",
      "sends",
      "deliveries",
      "notifications",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("sends.remade_at exists and is nullable (a send that was never re-made carries null)", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(sends)").all<{
      name: string;
      notnull: number;
    }>();
    const col = results.find((c) => c.name === "remade_at");
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
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('sn1','x@example.com','pending',?)",
    )
      .bind(now)
      .run();

    // INSERT OR IGNORE is a no-op on the dup (this is what makes resume safe).
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries (send_id, email, status, updated_at) VALUES ('sn1','x@example.com','pending',?)",
    )
      .bind(now)
      .run();
    expect(res.meta.changes).toBe(0);
  });

  it("rejects `failed` as a send status: a send never fails (SPEC §12)", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES ('p3','p-3','draft',?,?)",
    )
      .bind(now, now)
      .run();
    await expect(
      env.DB.prepare(
        "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('sf1','p3','failed',?, '', '', '', ?)",
      )
        .bind(now, now)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
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

  describe("the constraints the baseline froze with", () => {
    const now = Date.now();
    /** A send to hang deliveries on, made once per test id. */
    async function aSend(id: string): Promise<void> {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
      )
        .bind(`p-${id}`, `p-${id}`, now, now)
        .run();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, ?, 'sent', ?, '', '', '', ?)",
      )
        .bind(id, `p-${id}`, now, now)
        .run();
    }
    const delivery = (sendId: string, email: string, extra = "", binds: unknown[] = []) =>
      env.DB.prepare(
        `INSERT INTO deliveries (send_id, email, status, updated_at${extra ? `, ${extra}` : ""}) VALUES (?, ?, 'accepted', ?${binds.map(() => ", ?").join("")})`,
      )
        .bind(sendId, email, now, ...binds)
        .run();

    it("is STRICT: a value of the wrong type is refused, not stored as it came", async () => {
      const { results } = await env.DB.prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND strict = 0",
      ).all<{ name: string }>();
      expect(results.map((r) => r.name).filter((n) => n !== "d1_migrations")).toEqual([]);
      await aSend("st1");
      await expect(
        env.DB.prepare(
          "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('st1', 'a@example.com', 'pending', 'yesterday')",
        ).run(),
      ).rejects.toThrow(/cannot store TEXT value in INTEGER column/);
    });

    it("holds every address lowercased, admitting an erasure's placeholder", async () => {
      await aSend("lc1");
      await expect(delivery("lc1", "Bob@Example.com")).rejects.toThrow(/CHECK/);
      await expect(
        env.DB.prepare(
          "INSERT INTO suppressions (email, reason, created_at) VALUES ('Bob@Example.com', 'bounce', ?)",
        )
          .bind(now)
          .run(),
      ).rejects.toThrow(/CHECK/);
      await expect(
        env.DB.prepare(
          "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('lc-s', 'Bob@Example.com', 'pending', 'lc-u', ?)",
        )
          .bind(now)
          .run(),
      ).rejects.toThrow(/CHECK/);
      await delivery("lc1", "erased:0f3a9c2e7b1d4e8f");
    });

    it("admits only the known suppression reasons and delivery events", async () => {
      for (const reason of [
        "bounce",
        "complaint",
        "manual",
        "erased",
        "import_bounce",
        "import_complaint",
      ]) {
        await env.DB.prepare(
          "INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)",
        )
          .bind(`${reason}@example.com`, reason, now)
          .run();
      }
      await expect(
        env.DB.prepare(
          "INSERT INTO suppressions (email, reason, created_at) VALUES ('x@example.com', 'spam', ?)",
        )
          .bind(now)
          .run(),
      ).rejects.toThrow(/CHECK/);
      await aSend("ev1");
      await expect(delivery("ev1", "ev@example.com", "event", ["opened"])).rejects.toThrow(/CHECK/);
    });

    it("keeps one delivery per provider message id, and any number with none", async () => {
      await aSend("pv1");
      await delivery("pv1", "a@example.com", "provider_id", ["msg-1"]);
      await delivery("pv1", "b@example.com");
      await delivery("pv1", "c@example.com");
      await expect(delivery("pv1", "d@example.com", "provider_id", ["msg-1"])).rejects.toThrow(
        /UNIQUE/,
      );
    });

    it("refuses an image with no size", async () => {
      await aSend("im1");
      await expect(
        env.DB.prepare(
          "INSERT INTO images (id, post_id, filename, storage_key, content_type, width, height, created_at) VALUES ('im', 'p-im1', 'a.png', 'k', 'image/png', 0, 10, ?)",
        )
          .bind(now)
          .run(),
      ).rejects.toThrow(/CHECK/);
    });

    it("finds a send's stale in-flight rows and an address's deliveries through their own indexes", async () => {
      const plan = async (sql: string) =>
        (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results
          .map((r) => r.detail)
          .join("\n");
      expect(
        await plan(
          "SELECT COUNT(*) FROM deliveries WHERE status = 'dispatched' AND updated_at < 5",
        ),
      ).toMatch(/idx_deliveries_in_flight/);
      expect(
        await plan(
          "SELECT id FROM deliveries WHERE email = 'a@example.com' ORDER BY updated_at DESC LIMIT 1",
        ),
      ).toMatch(/idx_deliveries_email/);
    });
  });
});

// Vite reads each migration's text at build time; the Worker has no filesystem to read it.
const MIGRATIONS = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("the send change sequence (0002_send_rev)", () => {
  it("stamps a change to every column of sends but the lease's expiry", async () => {
    const [{ results: cols }, trigger] = await Promise.all([
      env.DB.prepare("PRAGMA table_info(sends)").all<{ name: string }>(),
      env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sends_rev_update'",
      ).first<{ sql: string }>(),
    ]);
    expect(trigger).toBeTruthy();
    // A column added to sends must join the trigger's list, or a change to it is one a
    // client following the sequence would never hear about.
    const watched = cols
      .map((c) => c.name)
      .filter((name) => name !== "locked_until" && name !== "rev");
    for (const name of watched) {
      expect(trigger!.sql, name).toContain(`NEW.${name} IS NOT OLD.${name}`);
    }
    expect(trigger!.sql).not.toContain("NEW.locked_until");
  });

  it("keeps every migration in the form D1's remote splitter reads", () => {
    const files = Object.entries(MIGRATIONS);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const [file, sql] of files) {
      // A carriage return, or a trigger body opened by anything but an uppercase BEGIN,
      // applies locally and in this suite but fails `migrate:remote` (the splitter only
      // runs there), so the break would surface first in a deploy.
      expect(sql, file).not.toContain("\r");
      for (const begin of sql.matchAll(/^\s*begin\b/gim)) {
        expect(begin[0].trim(), file).toBe("BEGIN");
      }
      // Nor may a trigger be the file's last statement.
      const statements = sql
        .replace(/--.*$/gm, "")
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean);
      expect(statements.at(-1), file).not.toMatch(/^END$|CREATE TRIGGER/i);
    }
  });
});
