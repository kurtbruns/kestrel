import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { SHIPPED_MIGRATIONS } from "../src/db/migrations";

// The migrations folder as vitest.config.ts read it, the same files the setup applied.
const FOLDER = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

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
    await env.DB.prepare("DELETE FROM subscribers").run();
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
    await env.DB.batch([
      env.DB.prepare("DELETE FROM notifications"),
      env.DB.prepare("DELETE FROM imports"),
    ]);
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
    await env.DB.prepare("DELETE FROM imports").run();
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
