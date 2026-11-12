/*
 * The maintainer's reset (.claude/skills/reset-instance/scripts/plan.mjs): what it clears and keeps,
 * what it refuses on, and what it shows the maintainer first. Each test runs the skill's own
 * SQL on a database built from migrations/ with Node's SQLite, so a table a migration adds
 * fails here until the skill says whether a reset clears it or keeps it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLEARED,
  clearSql,
  judge,
  KEPT,
  MOST_TO_NAME,
  QUERIES,
  RECENT_MS,
} from "../../.claude/skills/reset-instance/scripts/plan.mjs";

// Vite doesn't resolve `node:sqlite` as an import, so it is taken from the process.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");
const NOW = Date.now();
const LONG_AGO = NOW - 24 * 60 * 60 * 1000;
const ME = "me@maintainer.test";

let db;

function run(sql, ...binds) {
  db.prepare(sql).run(...binds);
}

function count(table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

/** Every read the skill makes, and its judgment of them at `now`. */
function inspect(now = NOW) {
  const read = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    read[name] = db.prepare(sql).all();
  }
  return judge(read, now);
}

function subscriber(email, status = "confirmed", cause = null) {
  run(
    "INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribe_cause) VALUES (?, ?, ?, ?, ?, ?)",
    `sub-${email}`,
    email,
    status,
    `unsub-${email}`,
    LONG_AGO,
    cause,
  );
}

function post(id, { emailOnly = false, author = ME } = {}) {
  run(
    "INSERT INTO posts (id, slug, email_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    id,
    id,
    emailOnly ? 1 : 0,
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO post_revisions (id, post_id, author, created_at) VALUES (?, ?, ?, ?)",
    `rev-${id}`,
    id,
    author,
    LONG_AGO,
  );
}

function send(id, postId, status, { to = [], by = ME } = {}) {
  run(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, ?, ?, ?, 'h', 't', ?, ?)",
    id,
    postId,
    status,
    LONG_AGO,
    `Subject of ${postId}`,
    LONG_AGO,
  );
  run(
    "INSERT INTO send_acts (send_id, act, at, actor, fire_at) VALUES (?, 'schedule', ?, ?, ?)",
    id,
    LONG_AGO,
    JSON.stringify({ kind: "human", email: by, client: "editor" }),
    LONG_AGO,
  );
  for (const email of to) {
    run(
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES (?, ?, 'accepted', ?)",
      id,
      email,
      LONG_AGO,
    );
  }
}

/** An instance as a maintainer's testing leaves it: named, email proven, one sent post with an
 *  image, mailed to the test recipient. */
function tested() {
  run(
    "INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)",
    JSON.stringify({
      publication: { name: "Scratch Letter" },
      timeZone: "America/Los_Angeles",
      testRecipients: [ME],
    }),
    LONG_AGO,
  );
  run(
    // The migrations leave an unproven row; this is the instance once email has gone out.
    "INSERT OR REPLACE INTO sending (id, state, since, observed_at, last_accepted_at, last_accepted_by, last_receipt_at) VALUES (1, 'working', ?, ?, ?, 'list', ?)",
    LONG_AGO,
    LONG_AGO,
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO provider_account (id, attempted_at, outcome) VALUES (1, ?, 'unreachable')",
    LONG_AGO,
  );
  subscriber(ME);
  post("first");
  run(
    "INSERT INTO images (id, post_id, filename, storage_key, content_type, created_at) VALUES ('img', 'first', 'cover.png', 'posts/first/cover.png', 'image/png', ?)",
    LONG_AGO,
  );
  send("send-first", "first", "sent", { to: [ME] });
}

/** A row in each table `tested()` leaves empty, so the clear is tried against every one. */
function fillTheRest() {
  run(
    "INSERT INTO imports (id, created_at, principal_kind, principal_email, file_name, file_sha256, plan_hash, counts) VALUES ('imp', ?, 'human', ?, 'a.csv', 'x', 'y', '{}')",
    LONG_AGO,
    ME,
  );
  run(
    "INSERT INTO suppressions (email, reason, created_at) VALUES ('bounce@simulator.amazonses.com', 'bounce', ?)",
    LONG_AGO,
  );
  run(
    "INSERT INTO notifications (send_id, kind, created_at, updated_at) VALUES ('send-first', 'finished', ?, ?)",
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO notifications (kind, created_at, updated_at) VALUES ('sandbox', ?, ?)",
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO held_receipts (provider_id, email, event, at, delivery_id) VALUES ('pid', ?, 'delivered', ?, 1)",
    ME,
    LONG_AGO,
  );
  run("INSERT INTO send_tombstones (id, rev) VALUES ('gone', 3)");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file.endsWith(".sql")) {
      db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
  }
});

describe("what a reset clears and keeps", () => {
  it("names every table the migrations make as cleared or kept", () => {
    const tables = db
      .prepare(QUERIES.tables)
      .all()
      .map((r) => r.name);

    expect(tables).toEqual([...CLEARED, ...KEPT].sort());
  });

  it("empties every cleared table and leaves every kept row as it was", () => {
    tested();
    fillTheRest();
    const kept = () => KEPT.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    const before = kept();
    expect(CLEARED.filter((t) => count(t) === 0)).toEqual([]);

    db.exec(clearSql());

    expect(CLEARED.filter((t) => count(t) !== 0)).toEqual([]);
    expect(kept()).toEqual(before);
  });

  it("is refused by the foreign keys in any order that deletes a parent first", () => {
    tested();

    expect(() => db.exec("DELETE FROM posts")).toThrow(/FOREIGN KEY/);
  });

  it("leaves a table whose name only looks like one of SQLite's or Cloudflare's to be refused", () => {
    db.exec("CREATE TABLE xcfxlist (id INTEGER PRIMARY KEY)");

    expect(
      db
        .prepare(QUERIES.tables)
        .all()
        .map((r) => r.name),
    ).toContain("xcfxlist");
  });

  it("can be run again on an instance it already cleared", () => {
    tested();
    db.exec(clearSql());

    db.exec(clearSql());

    expect(count("settings")).toBe(1);
  });
});

describe("what the maintainer is shown", () => {
  it("passes an instance that mailed only its test recipient, naming no address", () => {
    tested();

    const { refusals, toName } = inspect();

    expect(refusals).toEqual([]);
    expect(toName.addresses).toEqual([]);
    expect(toName.author).toBe(ME);
    expect(toName.publication.name).toBe("Scratch Letter");
    expect(toName.images).toEqual(["posts/first/cover.png"]);
  });

  it("names a confirmed reader who isn't a test recipient, with what the instance holds", () => {
    tested();
    subscriber("jane.reader@gmail.com");
    run(
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('send-first', 'jane.reader@gmail.com', 'accepted', ?)",
      LONG_AGO,
    );

    const { refusals, toName } = inspect();

    expect(refusals).toEqual([]);
    expect(toName.addresses).toEqual([
      {
        email: "jane.reader@gmail.com",
        what: "confirmed subscriber; in the delivery record of 1 send(s)",
      },
    ]);
  });

  it("names an address that left, one only the delivery record holds, and one that was suppressed", () => {
    tested();
    subscriber("left@gmail.com", "unsubscribed", "reader");
    send("send-old", "first", "sent", { to: ["mailed@gmail.com"] });
    run(
      "INSERT INTO suppressions (email, reason, created_at) VALUES ('blocked@gmail.com', 'manual', ?)",
      LONG_AGO,
    );

    const { toName } = inspect();

    expect(toName.addresses.map((a) => a.email)).toEqual([
      "blocked@gmail.com",
      "left@gmail.com",
      "mailed@gmail.com",
    ]);
  });

  it("lists a pending signup apart, and leaves out the provider's simulator and an erasure's placeholder", () => {
    tested();
    subscriber("reviewer@amazon.com", "pending");
    send("send-old", "first", "sent", {
      to: ["bounce@simulator.amazonses.com", "erased:0a1b2c"],
    });

    const { toName } = inspect();

    expect(toName.addresses).toEqual([]);
    expect(toName.pending).toEqual(["reviewer@amazon.com"]);
  });

  it("names every sent post with who it reached and whether the archive lists it", () => {
    tested();
    post("quiet", { emailOnly: true });
    send("send-quiet", "quiet", "sent", { to: [ME, "second@maintainer.test"] });
    post("draft");
    send("send-canceled", "draft", "canceled");

    const { toName } = inspect();

    expect(toName.sent.map((s) => [s.subject, s.listed, s.recipients])).toEqual([
      ["Subject of first", true, 1],
      ["Subject of quiet", false, 2],
    ]);
  });

  it("names an address the provider's own list may still refuse, never a simulator one", () => {
    tested();
    run(
      "INSERT INTO suppressions (email, reason, created_at) VALUES ('gone@gmail.com', 'bounce', ?)",
      LONG_AGO,
    );
    run(
      "INSERT INTO suppressions (email, reason, created_at) VALUES ('bounce@simulator.amazonses.com', 'bounce', ?)",
      LONG_AGO,
    );

    const { toName } = inspect();

    expect(toName.refusedByProvider).toEqual(["gone@gmail.com"]);
  });

  it("names an address that only begins like an erasure's placeholder", () => {
    tested();
    subscriber("erased:x@gmail.com");

    expect(inspect().toName.addresses.map((a) => a.email)).toEqual(["erased:x@gmail.com"]);
  });

  it("counts a sent post's recipients as those the provider took, not those skipped or unsent", () => {
    tested();
    run(
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('send-first', 'skipped@maintainer.test', 'skipped', ?)",
      LONG_AGO,
    );
    run(
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('send-first', 'unsent@maintainer.test', 'unsent', ?)",
      LONG_AGO,
    );

    expect(inspect().toName.sent[0].recipients).toBe(1);
  });

  it("lists the test recipients themselves", () => {
    tested();

    expect(inspect().toName.testRecipients).toEqual([ME]);
  });

  it("still names every reader when the test recipients hold a null", () => {
    tested();
    run(
      "UPDATE settings SET data = ?",
      JSON.stringify({ publication: { name: "Scratch Letter" }, testRecipients: [null, ME] }),
    );
    subscriber("jane.reader@gmail.com");

    const { toName } = inspect();

    expect(toName.addresses.map((a) => a.email)).toEqual(["jane.reader@gmail.com"]);
    expect(toName.testRecipients).toEqual([ME]);
  });

  it("names every address when no settings were ever saved", () => {
    tested();
    run("DELETE FROM settings");

    expect(inspect().toName.addresses.map((a) => a.email)).toEqual([ME]);
  });

  it("names an address only a receipt waiting for its delivery holds", () => {
    tested();
    run(
      "INSERT INTO held_receipts (provider_id, email, event, at, delivery_id) VALUES ('pid', 'waiting@gmail.com', 'delivered', ?, 1)",
      LONG_AGO,
    );

    expect(inspect().toName.addresses).toEqual([
      { email: "waiting@gmail.com", what: "in 1 receipt(s) waiting for a delivery" },
    ]);
  });

  it("deletes only a post's images, and reports a key kept anywhere else", () => {
    tested();
    run(
      "INSERT INTO images (id, post_id, filename, storage_key, content_type, created_at) VALUES ('odd', 'first', 'logo.png', 'branding/logo.png', 'image/png', ?)",
      LONG_AGO,
    );

    const { toName } = inspect();

    expect(toName.images).toEqual(["posts/first/cover.png"]);
    expect(toName.strayImages).toEqual(["branding/logo.png"]);
  });

  it("gives a different fingerprint when one pending signup replaces another", () => {
    tested();
    subscriber("first@gmail.com", "pending");
    const before = JSON.stringify(inspect().fingerprint);

    run("DELETE FROM subscribers WHERE email = 'first@gmail.com'");
    subscriber("second@gmail.com", "pending");

    expect(JSON.stringify(inspect().fingerprint)).not.toBe(before);
  });

  it("gives a different fingerprint when a post is edited in place, the name changes, or a test recipient is added", () => {
    tested();
    const before = JSON.stringify(inspect().fingerprint);
    const changed = () => JSON.stringify(inspect().fingerprint) !== before;

    run("UPDATE posts SET updated_at = updated_at + 1");
    expect(changed()).toBe(true);
    run("UPDATE posts SET updated_at = updated_at - 1");
    expect(changed()).toBe(false);

    run("UPDATE settings SET data = json_set(data, '$.publication.name', 'Another Letter')");
    expect(changed()).toBe(true);
    run("UPDATE settings SET data = json_set(data, '$.publication.name', 'Scratch Letter')");
    expect(changed()).toBe(false);

    run("UPDATE settings SET data = json_set(data, '$.testRecipients[#]', 'new@maintainer.test')");
    expect(changed()).toBe(true);
  });

  it("gives a different fingerprint once a reader arrives after the look", () => {
    tested();
    const before = JSON.stringify(inspect().fingerprint);

    subscriber("late@gmail.com");

    expect(JSON.stringify(inspect().fingerprint)).not.toBe(before);
  });
});

describe("what a reset refuses", () => {
  it("refuses while a send is scheduled", () => {
    tested();
    post("next");
    send("send-next", "next", "scheduled");

    const { refusals } = inspect();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("1 send(s) are scheduled or sending");
  });

  it("refuses while the provider took an email within the last ten minutes, and not after", () => {
    tested();
    run("UPDATE sending SET last_accepted_at = ?", NOW - RECENT_MS + 1000);

    expect(inspect().refusals).toHaveLength(1);
    expect(inspect().refusals[0]).toContain("took an email less than 10 minutes ago");
    expect(inspect(NOW + 1000).refusals).toEqual([]);
  });

  it("refuses once a second person has written a post", () => {
    tested();
    post("theirs", { author: "publisher@example.com" });

    const { refusals } = inspect();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("2 people have written or acted here");
    expect(refusals[0]).toContain("publisher@example.com");
  });

  it("refuses once a second person has acted on a send or run an import", () => {
    tested();
    post("next");
    send("send-next", "next", "canceled", { by: "publisher@example.com" });
    run(
      "INSERT INTO imports (id, created_at, principal_kind, principal_email, file_name, file_sha256, plan_hash, counts) VALUES ('imp', ?, 'human', 'third@example.com', 'a.csv', 'x', 'y', '{}')",
      LONG_AGO,
    );

    const { refusals } = inspect();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("3 people have written or acted here");
  });

  it("reads one person as one, whatever case their sign-in and their import kept the address in", () => {
    tested();
    post("mixed", { author: "Me@Maintainer.test" });
    send("send-mixed", "mixed", "canceled", { by: "ME@maintainer.test" });

    const { refusals, toName } = inspect();

    expect(refusals).toEqual([]);
    expect(toName.author).toBe(ME);
  });

  it("lets a service token's acts through beside one person's, and says it acted", () => {
    tested();
    post("by-token", { author: "service" });

    const { refusals, toName } = inspect();

    expect(refusals).toEqual([]);
    expect(toName.serviceActed).toBe(true);
  });

  it("names as many addresses as a person can, pending ones counted with the rest, and refuses one more", () => {
    tested();
    for (let i = 0; i < MOST_TO_NAME - 10; i++) {
      subscriber(`reader${i}@gmail.com`);
    }
    for (let i = 0; i < 10; i++) {
      subscriber(`invited${i}@gmail.com`, "pending");
    }
    expect(inspect().refusals).toEqual([]);

    subscriber("one.more@gmail.com", "pending");
    const { refusals } = inspect();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(
      `${MOST_TO_NAME + 1} addresses here aren't test recipients (11 of them pending)`,
    );
  });

  it("refuses an instance whose tables it doesn't know, and reads nothing else from it", () => {
    tested();
    db.exec("CREATE TABLE reactions (id INTEGER PRIMARY KEY)");

    const { refusals, toName } = inspect();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("not known: reactions");
    expect(toName).toBe(null);
  });
});
