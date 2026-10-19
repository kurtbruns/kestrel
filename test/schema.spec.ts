import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SHIPPED_MIGRATIONS } from "../src/db/migrations";
import { resetDatabase } from "./support/fixtures";

// The migrations folder as vitest.config.ts read it, the same files the setup applied.
const FOLDER = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

beforeEach(resetDatabase);

describe("the migrations the schema gate expects (SPEC §9)", () => {
  it("are exactly the files in migrations/, in order, so a new migration can't be left out", () => {
    // Each by its file name, as wrangler records it in `d1_migrations`.
    expect([...SHIPPED_MIGRATIONS]).toEqual(FOLDER.map((m) => m.name));
  });
});

// The exact set, not a containment check: a table a migration adds or drops has to be
// named here, so the list can't silently fall behind the schema.
describe("schema (every migration applied)", () => {
  it("has exactly the app's eleven tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(
      [
        // 0001_init
        "deliveries",
        "images",
        "notifications",
        "post_revisions",
        "posts",
        "sends",
        "settings",
        "subscribers",
        "suppressions",
        // 0002_sends_since_1_0
        "send_tombstones",
        // 0005_imports
        "imports",
      ].sort(),
    );
  });
});

describe("schema (0006_deliveries_fewer_indexes)", () => {
  const plan = async (sql: string, ...binds: unknown[]) =>
    (
      await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join("\n");

  it("keeps on deliveries only the indexes a query reads", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deliveries' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "idx_deliveries_email",
      "idx_deliveries_provider",
      "idx_deliveries_send_status",
    ]);
  });

  it("still reads a batch's rows by key through the send's own index", async () => {
    expect(
      await plan(
        "SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND dispatch_key IN (SELECT value FROM json_each(?)) AND status = ?",
        "s",
        '["k"]',
        "dispatched",
      ),
    ).toMatch(
      /SEARCH deliveries USING INDEX idx_deliveries_send_status \(send_id=\? AND status=\?\)/,
    );
  });
});

describe("schema (0005_imports)", () => {
  it("reads every subscriber made before it as joining through this app's double opt-in", async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('s1', 'a@example.com', 'confirmed', 'u1', 1)",
    ).run();
    const row = await env.DB.prepare(
      "SELECT origin, opt_in, consent_evidence, import_id FROM subscribers WHERE id = 's1'",
    ).first();
    expect(row).toEqual({
      origin: "kestrel",
      opt_in: "double",
      consent_evidence: null,
      import_id: null,
    });
  });

  it("refuses an opt-in method outside the three, and evidence that isn't JSON", async () => {
    const insert = (optIn: string, evidence: string | null) =>
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at, opt_in, consent_evidence) VALUES ('s2', 'b@example.com', 'confirmed', 'u2', 1, ?, ?)",
      )
        .bind(optIn, evidence)
        .run();
    await expect(insert("triple", null)).rejects.toThrow();
    await expect(insert("single", "{not json")).rejects.toThrow();
  });

  it("admits an import notice, with an import and no send, and keeps a send's notice tied to its send", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO imports (id, created_at, principal_kind, file_name, file_sha256, plan_hash, counts) VALUES ('i1', 1, 'service', 'list.csv', 'h', 'p', '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO notifications (import_id, kind, created_at, updated_at) VALUES ('i1', 'import', 1, 1)",
      ),
    ]);
    await expect(
      env.DB.prepare(
        "INSERT INTO notifications (kind, created_at, updated_at) VALUES ('import', 1, 1)",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO notifications (import_id, kind, created_at, updated_at) VALUES ('i1', 'finished', 1, 1)",
      ).run(),
    ).rejects.toThrow();
  });

  it("keeps one import per plan, the commit's idempotency key", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        "INSERT INTO imports (id, created_at, principal_kind, principal_email, file_name, file_sha256, plan_hash, counts) VALUES (?, 1, 'human', 'me@example.com', 'list.csv', 'h', 'same', '{}')",
      )
        .bind(id)
        .run();
    await insert("i1");
    await expect(insert("i2")).rejects.toThrow();
  });
});

describe("schema (0002_sends_since_1_0)", () => {
  it("adds a send's change number (required, default 0) and when it was last tested (nullable)", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(sends)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    expect(results.find((c) => c.name === "rev")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(results.find((c) => c.name === "tested_at")).toMatchObject({ notnull: 0 });
  });
});

describe("schema (0001_init)", () => {
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

    it("admits only the suppression reasons 0012 left, the sender's side, and the known delivery events", async () => {
      for (const reason of ["bounce", "manual", "import_bounce"]) {
        await env.DB.prepare(
          "INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)",
        )
          .bind(`${reason}@example.com`, reason, now)
          .run();
      }
      for (const reason of ["complaint", "erased", "import_complaint", "spam"]) {
        await expect(
          env.DB.prepare(
            "INSERT INTO suppressions (email, reason, created_at) VALUES ('x@example.com', ?, ?)",
          )
            .bind(reason, now)
            .run(),
        ).rejects.toThrow(/CHECK/);
      }
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

    it("finds an address's deliveries through its own index", async () => {
      const plan = async (sql: string) =>
        (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results
          .map((r) => r.detail)
          .join("\n");
      expect(
        await plan(
          "SELECT id FROM deliveries WHERE email = 'a@example.com' ORDER BY updated_at DESC LIMIT 1",
        ),
      ).toMatch(/idx_deliveries_email/);
    });
  });
});

describe("schema (0010_unlisted_links)", () => {
  const insert = (id: string, slug: string) =>
    env.DB.prepare("INSERT INTO posts (id, slug, created_at, updated_at) VALUES (?, ?, 0, 0)")
      .bind(id, slug)
      .run();

  it("gives every post its own 128-bit unlisted token, however it is inserted (SPEC §5)", async () => {
    await insert("a", "one");
    await insert("b", "two");
    const { results } = await env.DB.prepare("SELECT unlisted_token FROM posts ORDER BY id").all<{
      unlisted_token: string;
    }>();
    const [a, b] = results.map((r) => r.unlisted_token);
    expect(a).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(b).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(a).not.toBe(b);
  });

  it("records a send inserted without naming its link as carrying the archive address, as the previous release's Worker inserts one (SPEC §5)", async () => {
    // The previous release's Worker keeps serving between this migration and the deploy, and
    // after a rollback; every send it freezes links the archive address.
    await insert("a", "one");
    await env.DB.prepare(
      "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s1', 'a', 'scheduled', 0, '', '', '', 0)",
    ).run();
    const row = await env.DB.prepare("SELECT web_link FROM sends WHERE id = 's1'").first<{
      web_link: string;
    }>();
    expect(row?.web_link).toBe("archive");
  });

  it("gives every post that existed before it a well-formed token of its own", async () => {
    // As the posts stood before 0008: no token. The trigger fills one on insert, so take it
    // away again, then run the migration's own backfill over them.
    await insert("a", "one");
    await insert("b", "two");
    await env.DB.prepare("UPDATE posts SET unlisted_token = NULL").run();
    const migration = FOLDER.find((m) => m.name === "0010_unlisted_links.sql");
    const backfill = (migration?.queries ?? []).filter((q) =>
      /^UPDATE posts SET unlisted_token/.test(q),
    );
    expect(backfill).toHaveLength(2);
    for (const q of backfill) {
      await env.DB.prepare(q).run();
    }
    const { results } = await env.DB.prepare("SELECT unlisted_token FROM posts").all<{
      unlisted_token: string;
    }>();
    const tokens = results.map((r) => r.unlisted_token);
    for (const t of tokens) {
      expect(t).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    }
    expect(new Set(tokens).size).toBe(2);
  });

  it("keeps every post's slug its own, drafts included (SPEC §4)", async () => {
    await insert("a", "spring");
    await expect(insert("b", "spring")).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("schema (0011_sends_render_warnings)", () => {
  it("reads a send frozen without its warnings, as the previous release's Worker freezes one, as having none (SPEC §5)", async () => {
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('a', 'one', 0, 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s1', 'a', 'scheduled', 0, '', '', '', 0)",
    ).run();
    const row = await env.DB.prepare("SELECT render_warnings FROM sends WHERE id = 's1'").first<{
      render_warnings: string;
    }>();
    expect(row?.render_warnings).toBe("[]");
  });
});

describe("schema (0012_unsubscribe_cause)", () => {
  it("keeps why someone left exactly while they have left, and empty fields only on an erased record (SPEC §7)", async () => {
    const insert = (status: string, cause: string | null, token: string | null = "u") =>
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribe_cause) VALUES ('x', 'x@example.com', ?, ?, 0, ?)",
      )
        .bind(status, token, cause)
        .run();
    await expect(insert("unsubscribed", null)).rejects.toThrow(/CHECK/);
    await expect(insert("confirmed", "reader")).rejects.toThrow(/CHECK/);
    await expect(insert("unsubscribed", "reader", null)).rejects.toThrow(/CHECK/);
    await insert("unsubscribed", "erased", null);
    await env.DB.prepare("DELETE FROM subscribers").run();
    // A pending row that left before keeps its cause until it confirms.
    await insert("pending", "complaint");
  });

  it("admits only the five reasons for leaving (SPEC §7)", async () => {
    const insert = (cause: string) =>
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribe_cause) VALUES (?, ?, 'unsubscribed', ?, 0, ?)",
      )
        .bind(cause, `${cause}@example.com`, `u-${cause}`, cause)
        .run();
    for (const cause of ["reader", "publisher", "complaint", "erased", "import"]) {
      await insert(cause);
    }
    await expect(insert("spam")).rejects.toThrow(/CHECK/);
  });

  it("turns each complaint into an unsubscribe by it and each erasure into an address-only one, keeping bounces and blocks (SPEC §7)", async () => {
    // The subscribers and suppressions as they stood before it, in their old shapes. The live
    // tables are set aside, with the indexes the migration makes again, and the migration's own
    // statements run over the old ones, which they rebuild.
    await env.DB.batch([
      env.DB.prepare("DROP INDEX idx_subscribers_status"),
      env.DB.prepare("DROP INDEX idx_subscribers_created"),
      env.DB.prepare("ALTER TABLE subscribers RENAME TO subscribers_now"),
      env.DB.prepare("ALTER TABLE suppressions RENAME TO suppressions_now"),
    ]);
    let migrated = false;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `CREATE TABLE subscribers (
             id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
             confirm_token TEXT UNIQUE, confirm_sent_at INTEGER, confirm_attempt_at INTEGER,
             unsub_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, confirmed_at INTEGER,
             unsubscribed_at INTEGER, origin TEXT NOT NULL DEFAULT 'kestrel',
             opt_in TEXT NOT NULL DEFAULT 'double', consent_evidence TEXT, import_id TEXT
           ) STRICT`,
        ),
        env.DB.prepare(
          `CREATE TABLE suppressions (
             email TEXT PRIMARY KEY, reason TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
           ) STRICT`,
        ),
      ]);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO subscribers (id, email, status, unsub_token, created_at, confirmed_at, unsubscribed_at,
                                   origin, opt_in, consent_evidence, confirm_token)
           VALUES ('1', 'conf-c@x.io', 'confirmed', 'u1', 1, 2, NULL, 'kestrel', 'double', NULL, NULL),
                  ('2', 'left-c@x.io', 'unsubscribed', 'u2', 1, 2, 5, 'kestrel', 'double', NULL, NULL),
                  ('3', 'conf-e@x.io', 'confirmed', 'u3', 1, 2, NULL, 'sendy', 'single', '{"ip":"1.2.3.4"}', NULL),
                  ('4', 'pend-e@x.io', 'pending', 'u4', 7, NULL, NULL, 'kestrel', 'double', NULL, 'c4'),
                  ('5', 'left@x.io', 'unsubscribed', 'u5', 1, 2, 3, 'kestrel', 'double', NULL, NULL),
                  ('6', 'back@x.io', 'pending', 'u6', 1, NULL, 3, 'kestrel', 'double', NULL, 'c6'),
                  ('7', 'conf@x.io', 'confirmed', 'u7', 1, 2, NULL, 'kestrel', 'double', NULL, NULL)`,
        ),
        env.DB.prepare(
          `INSERT INTO suppressions (email, reason, detail, created_at)
           VALUES ('conf-c@x.io', 'complaint', 'abuse', 10),
                  ('left-c@x.io', 'import_complaint', 'imported', 11),
                  ('ghost-c@x.io', 'complaint', NULL, 12),
                  ('conf-e@x.io', 'erased', NULL, 13),
                  ('pend-e@x.io', 'erased', NULL, 4),
                  ('ghost-e@x.io', 'erased', NULL, 14),
                  ('b@x.io', 'bounce', '550', 15),
                  ('m@x.io', 'manual', 'by hand', 16),
                  ('ib@x.io', 'import_bounce', 'imported', 17)`,
        ),
      ]);
      const migration = FOLDER.find((m) => m.name === "0012_unsubscribe_cause.sql");
      const statements = migration?.queries ?? [];
      expect(statements.length).toBeGreaterThan(10);
      for (const q of statements) {
        await env.DB.prepare(q).run();
      }
      migrated = true;
    } finally {
      // The tables the migration rebuilt are the live ones now; had it failed, put the live ones
      // back, so the other tests still have them.
      if (!migrated) {
        await env.DB.batch([
          env.DB.prepare("DROP TABLE IF EXISTS subscribers_next"),
          env.DB.prepare("DROP TABLE IF EXISTS subscribers"),
          env.DB.prepare("DROP TABLE IF EXISTS suppressions_next"),
          env.DB.prepare("DROP TABLE IF EXISTS suppressions"),
          env.DB.prepare("ALTER TABLE subscribers_now RENAME TO subscribers"),
          env.DB.prepare("ALTER TABLE suppressions_now RENAME TO suppressions"),
          env.DB.prepare("CREATE INDEX idx_subscribers_status ON subscribers (status)"),
          env.DB.prepare("CREATE INDEX idx_subscribers_created ON subscribers (created_at)"),
        ]);
      }
    }
    await env.DB.prepare("DROP TABLE IF EXISTS subscribers_now").run();
    await env.DB.prepare("DROP TABLE IF EXISTS suppressions_now").run();

    const { results: subscribers } = await env.DB.prepare(
      `SELECT email, status, unsubscribe_cause, created_at, confirmed_at, unsubscribed_at, origin,
              opt_in, consent_evidence, confirm_token, unsub_token
         FROM subscribers ORDER BY email`,
    ).all<Record<string, unknown>>();
    const by = Object.fromEntries(subscribers.map((r) => [r.email, r]));
    const stripped = {
      status: "unsubscribed",
      unsubscribe_cause: "erased",
      confirmed_at: null,
      origin: null,
      opt_in: null,
      consent_evidence: null,
      confirm_token: null,
      unsub_token: null,
    };
    expect(by["conf-c@x.io"]).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "complaint",
      unsubscribed_at: 10,
    });
    expect(by["left-c@x.io"]).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "complaint",
      unsubscribed_at: 5,
    });
    expect(by["ghost-c@x.io"]).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "complaint",
      created_at: 12,
      unsubscribed_at: 12,
      origin: "unknown",
    });
    expect(by["conf-e@x.io"]).toMatchObject({ ...stripped, created_at: 13, unsubscribed_at: 13 });
    expect(by["ghost-e@x.io"]).toMatchObject({ ...stripped, created_at: 14, unsubscribed_at: 14 });
    expect(by["pend-e@x.io"]).toMatchObject({
      status: "pending",
      unsubscribe_cause: "erased",
      unsubscribed_at: 4,
      confirm_token: "c4",
    });
    expect(by["left@x.io"]).toMatchObject({ unsubscribe_cause: "reader" });
    expect(by["back@x.io"]).toMatchObject({ status: "pending", unsubscribe_cause: "reader" });
    expect(by["conf@x.io"]).toMatchObject({ status: "confirmed", unsubscribe_cause: null });
    // A complainer it records for an address with no subscriber gets a token of its own.
    expect(by["ghost-c@x.io"]?.unsub_token).toMatch(/^[0-9a-f]{64}$/);
    expect(by["conf@x.io"]?.unsub_token).toBe("u7");
    // The rebuilt table keeps its indexes.
    const { results: indexes } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'subscribers' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(indexes.map((i) => i.name)).toEqual([
      "idx_subscribers_created",
      "idx_subscribers_status",
    ]);

    expect(
      (
        await env.DB.prepare(
          "SELECT email, reason, detail, created_at FROM suppressions ORDER BY email",
        ).all()
      ).results,
    ).toEqual([
      { email: "b@x.io", reason: "bounce", detail: "550", created_at: 15 },
      { email: "ib@x.io", reason: "import_bounce", detail: "imported", created_at: 17 },
      { email: "m@x.io", reason: "manual", detail: "by hand", created_at: 16 },
    ]);
    await expect(
      env.DB.prepare(
        "INSERT INTO suppressions (email, reason, created_at) VALUES ('c@x.io', 'complaint', 1)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});
