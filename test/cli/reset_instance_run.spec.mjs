/*
 * The maintainer's reset as it is run (.claude/skills/reset-instance/scripts/reset.mjs): its
 * command line, which database and bucket it acts on, and the order of what it deletes. Each
 * test runs the real script on a scratch instance folder whose `wrangler` is a stand-in that
 * keeps the database in a SQLite file built from migrations/ and records each object a
 * command deletes, so nothing here reaches Cloudflare. What is read and refused from the data
 * is reset_instance.spec.mjs.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, parseJsonc } from "../../.claude/skills/reset-instance/scripts/reset.mjs";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, ".claude", "skills", "reset-instance", "scripts", "reset.mjs");
const MIGRATIONS = join(ROOT, "migrations");
const LONG_AGO = Date.now() - 24 * 60 * 60 * 1000;
const ME = "me@maintainer.test";

// The stand-in for an instance's wrangler: `d1 execute` against the SQLite file its
// environment names, `d1 time-travel info`, and `r2 object delete`, each call recorded.
// `fake.json` in the instance folder makes it misbehave for one test.
const FAKE_WRANGLER = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const args = process.argv.slice(2);
appendFileSync("calls.log", JSON.stringify(args) + "\\n");
const fake = existsSync("fake.json") ? JSON.parse(readFileSync("fake.json", "utf8")) : {};
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "d1" && args[1] === "execute") {
  const remote = args.includes("--remote") && value("--env") === "production";
  if (remote === args.includes("--local")) { console.error("neither local nor production"); process.exit(1); }
  const db = new DatabaseSync(remote ? "production.sqlite" : "local.sqlite");
  if (args.includes("--file")) {
    if (fake.failFile) { console.error("D1_ERROR: the file was refused"); process.exit(1); }
    db.exec(readFileSync(value("--file"), "utf8"));
    if (fake.loseAnswer) { console.error("fetch failed"); process.exit(1); }
    if (fake.afterFile) { db.exec(fake.afterFile); }
    console.log("uploaded");
  } else {
    console.log(JSON.stringify([{ results: db.prepare(value("--command")).all(), success: true }]));
  }
} else if (args[0] === "d1" && args[1] === "time-travel") {
  if (fake.noBookmark) { console.error("time travel is unavailable"); process.exit(1); }
  console.log(JSON.stringify({ bookmark: "bookmark-before" }));
} else if (args[0] === "r2" && args[2] === "delete") {
  if ((fake.failDelete ?? []).some((key) => args[3].endsWith(key))) { console.error("R2 said no"); process.exit(1); }
  appendFileSync("deleted.log", args[3] + " " + args[4] + "\\n");
} else {
  console.error("unexpected: " + args.join(" ")); process.exit(1);
}
`;

const WRANGLER_JSONC = `{
  // The development environment: a comment with a "quote" and a trailing comma below.
  "name": "scratch",
  "d1_databases": [{ "binding": "DB", "database_name": "scratch-dev", "database_id": "x" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "scratch-media-dev" }],
  "vars": { "APP_ORIGIN": "http://localhost:8787", },
  /* production redeclares everything */
  "env": {
    "production": {
      "d1_databases": [{ "binding": "DB", "database_name": "scratch-production", "database_id": "y" }],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "scratch-media-production" }],
      "vars": { "APP_ORIGIN": "https://letter.example.com" },
    },
  },
}
`;

let dir;

/** A database as a maintainer's testing leaves it, in the instance's `file`. */
function tested(file) {
  const db = new DatabaseSync(join(dir, file));
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name.endsWith(".sql")) {
      db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    }
  }
  const run = (sql, ...binds) => db.prepare(sql).run(...binds);
  run(
    "INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)",
    JSON.stringify({ publication: { name: `Letter in ${file}` }, testRecipients: [ME] }),
    LONG_AGO,
  );
  run(
    "INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('first', 'first', ?, ?)",
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO post_revisions (id, post_id, author, created_at) VALUES ('rev', 'first', ?, ?)",
    ME,
    LONG_AGO,
  );
  for (const key of ["posts/first/cover.png", "posts/first/a b&c.png"]) {
    run(
      "INSERT INTO images (id, post_id, filename, storage_key, content_type, created_at) VALUES (?, 'first', ?, ?, 'image/png', ?)",
      key,
      key,
      key,
      LONG_AGO,
    );
  }
  run(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('send', 'first', 'sent', ?, 'h', 't', 'The first post', ?)",
    LONG_AGO,
    LONG_AGO,
  );
  run(
    "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES ('send', ?, 'accepted', ?)",
    ME,
    LONG_AGO,
  );
  db.close();
}

function count(file, table) {
  const db = new DatabaseSync(join(dir, file));
  const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  db.close();
  return n;
}

function reset(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function fingerprint(...args) {
  const { out } = reset("inspect", dir, ...args);
  return /^fingerprint: (\w+)$/m.exec(out)?.[1];
}

const log = (name) =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n") : [];

const misbehave = (fake) => writeFileSync(join(dir, "fake.json"), JSON.stringify(fake));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-reset-spec-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "wrangler"), FAKE_WRANGLER);
  chmodSync(join(dir, "node_modules", ".bin", "wrangler"), 0o755);
  writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_JSONC);
  tested("production.sqlite");
  tested("local.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the command line", () => {
  it("refuses a flag it doesn't know, so a mistyped --local never reads production", () => {
    const { code, err } = reset("inspect", dir, "--locl");

    expect(code).toBe(1);
    expect(err).toContain("Unknown option --locl");
    expect(log("calls.log")).toEqual([]);
  });

  it("reads its arguments in any order, and refuses a second directory or a fingerprint with no value", () => {
    expect(parseArgs(["clear", "--local", "--fingerprint", "abc", "/x"])).toEqual({
      command: "clear",
      dir: "/x",
      local: true,
      fingerprint: "abc",
    });
    expect(() => parseArgs(["inspect", "/x", "/y"])).toThrow(/One instance directory/);
    expect(() => parseArgs(["clear", "/x", "--fingerprint"])).toThrow(/needs the value/);
    expect(() => parseArgs(["clear", "/x", "--fingerprint", "--local"])).toThrow(/needs the value/);
    expect(() => parseArgs(["clear", "/x"])).toThrow(/needs the fingerprint/);
    expect(() => parseArgs(["wipe", "/x"])).toThrow(/usage/);
    expect(() => parseArgs(["inspect", ""])).toThrow(/empty instance directory/);
  });

  it("reads a wrangler.jsonc with comments, trailing commas, and a comment marker inside a string", () => {
    expect(parseJsonc('{ "a": "http://x//y", /* b */ "c": [1, 2,], "e": "x,}", // d\n }')).toEqual({
      a: "http://x//y",
      c: [1, 2],
      e: "x,}",
    });
  });
});

describe("which instance it acts on", () => {
  it("names production's database, bucket, and address back, and reads only production", () => {
    const { code, out } = reset("inspect", dir);

    expect(code).toBe(0);
    expect(out).toContain("Instance (production)");
    expect(out).toContain("publication: Letter in production.sqlite");
    expect(out).toContain("address:     https://letter.example.com");
    expect(out).toContain("database:    scratch-production");
    expect(out).toContain("bucket:      scratch-media-production");
    expect(log("calls.log").every((call) => call.includes('"--remote","--env","production"'))).toBe(
      true,
    );
  });

  it("with --local, names and reads only the development database", () => {
    const { out } = reset("inspect", dir, "--local");

    expect(out).toContain("Instance (local development)");
    expect(out).toContain("publication: Letter in local.sqlite");
    expect(out).toContain("database:    scratch-dev");
    expect(log("calls.log").some((call) => call.includes("--remote"))).toBe(false);
  });

  it("gives production and local different fingerprints, so a yes to one never clears the other", () => {
    const local = fingerprint("--local");

    const { code, err } = reset("clear", dir, "--fingerprint", local);

    expect(code).toBe(2);
    expect(err).toContain("not as it was when it was inspected");
    expect(count("production.sqlite", "posts")).toBe(1);
  });

  it("refuses a folder with no production environment", () => {
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "name": "kestrel" }');

    const { code, err } = reset("inspect", dir);

    expect(code).toBe(1);
    expect(err).toContain("declares no production environment");
  });
});

describe("the clear", () => {
  it("clears production and deletes each post image from its bucket, leaving local alone", () => {
    const { code, out } = reset("clear", dir, "--fingerprint", fingerprint());

    expect(code).toBe(0);
    expect(out).toContain("RESET DONE");
    expect(out).toContain("images:      2 of 2 deleted from scratch-media-production");
    expect(count("production.sqlite", "posts")).toBe(0);
    expect(count("production.sqlite", "sends")).toBe(0);
    expect(count("production.sqlite", "settings")).toBe(1);
    expect(count("local.sqlite", "posts")).toBe(1);
    expect(log("deleted.log")).toEqual([
      "scratch-media-production/posts/first/a b&c.png --remote",
      "scratch-media-production/posts/first/cover.png --remote",
    ]);
  });

  it("prints the restore point before it deletes anything, and again in the summary", () => {
    const { out } = reset("clear", dir, "--fingerprint", fingerprint());

    const first = out.indexOf("bookmark-before");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(out.indexOf("RESET DONE"));
    expect(out.lastIndexOf("bookmark-before")).toBeGreaterThan(out.indexOf("RESET DONE"));
  });

  it("changes nothing when no restore point can be read", () => {
    const shown = fingerprint();
    misbehave({ noBookmark: true });

    const { code, err } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(1);
    expect(err).toContain("No restore point could be read, so nothing was changed");
    expect(count("production.sqlite", "posts")).toBe(1);
    expect(log("deleted.log")).toEqual([]);
  });

  it("refuses a fingerprint from before a reader arrived, and changes nothing", () => {
    const shown = fingerprint();
    const db = new DatabaseSync(join(dir, "production.sqlite"));
    db.exec(
      `INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('late', 'late@gmail.com', 'confirmed', 'u', ${LONG_AGO})`,
    );
    db.close();

    const { code, err } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(2);
    expect(err).toContain("not as it was when it was inspected");
    expect(count("production.sqlite", "posts")).toBe(1);
    expect(log("deleted.log")).toEqual([]);
  });

  it("says the restore point and deletes no image when the clear itself fails", () => {
    const shown = fingerprint();
    misbehave({ failFile: true });

    const { code, out } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(3);
    expect(out).toContain("Restore point (database only, before the clear): bookmark-before");
    expect(out).toContain("The clear's command failed: D1_ERROR: the file was refused");
    expect(out).toContain("RESET NOT FINISHED");
    expect(out).toContain("images:      none deleted, since their rows are still there");
    expect(count("production.sqlite", "images")).toBe(2);
    expect(log("deleted.log")).toEqual([]);
  });

  it("deletes the images when the command fails after the database ran the clear", () => {
    const shown = fingerprint();
    misbehave({ loseAnswer: true });

    const { code, out } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(0);
    expect(out).toContain("The clear's command failed: fetch failed");
    expect(out).toContain("RESET DONE");
    expect(log("deleted.log")).toHaveLength(2);
  });

  it("prints each image's key before it deletes anything", () => {
    const { out } = reset("clear", dir, "--fingerprint", fingerprint());

    const listed = out.indexOf("  posts/first/cover.png");
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(out.indexOf("RESET DONE"));
  });

  it("names the config file it read on every wrangler call", () => {
    reset("clear", dir, "--fingerprint", fingerprint());

    const config = JSON.stringify(join(dir, "wrangler.jsonc")).slice(1, -1);
    expect(log("calls.log").filter((call) => !call.includes(`"--config","${config}"`))).toEqual([]);
  });

  it("still deletes the images when the app writes a row while the clear runs, and says it isn't finished", () => {
    const shown = fingerprint();
    misbehave({
      afterFile: `INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES ('late', 'late@gmail.com', 'pending', 'u', ${LONG_AGO})`,
    });

    const { code, out, err } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(3);
    expect(out).toContain("RESET NOT FINISHED");
    expect(err).toContain("subscribers still hold rows");
    expect(log("deleted.log")).toHaveLength(2);
  });

  it("deletes no image while their rows are still there, so the next run can find them", () => {
    const shown = fingerprint();
    misbehave({
      afterFile: `INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('p2', 'p2', 1, 1);
        INSERT INTO images (id, post_id, filename, storage_key, content_type, created_at) VALUES ('i2', 'p2', 'x.png', 'posts/p2/x.png', 'image/png', 1)`,
    });

    const { code, out } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(3);
    expect(out).toContain("images:      none deleted, since their rows are still there");
    expect(log("deleted.log")).toEqual([]);
  });

  it("names an image the bucket refused to delete, and ends as not done", () => {
    const shown = fingerprint();
    misbehave({ failDelete: ["cover.png"] });

    const { code, out } = reset("clear", dir, "--fingerprint", shown);

    expect(code).toBe(3);
    expect(out).toContain("images:      1 of 2 deleted");
    expect(out).toContain("NOT deleted: posts/first/cover.png: R2 said no");
  });
});
