/*
 * `kestrel sync-migrations` (cli/sync-migrations.mjs), the first step of every upgrade: it
 * copies the installed release's migrations into the instance's migrations/ folder, keeps a
 * copy already there, and refuses to overwrite one that differs, since a shipped migration is
 * never edited. Run as an instance's npm script runs it, `bin/kestrel.mjs` in the instance's
 * folder, on an instance the real `kestrel init` wrote into a temp directory (init only copies
 * files, so it is quick and needs no network).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(PACKAGE_ROOT, "bin", "kestrel.mjs");
const SHIPPED = join(PACKAGE_ROOT, "migrations");
const SHIPPED_NAMES = readdirSync(SHIPPED)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const FIRST = SHIPPED_NAMES[0];
const LAST = SHIPPED_NAMES.at(-1);

/** Run `kestrel <args>` in `cwd`, as an instance's npm script does. */
const kestrel = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let dir;
let instance;
let migrations;
const shipped = (name) => readFileSync(join(SHIPPED, name), "utf8");
const theirs = (name) => readFileSync(join(migrations, name), "utf8");
const listed = () => readdirSync(migrations).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-sync-migrations-"));
  instance = join(dir, "newsletter");
  migrations = join(instance, "migrations");
  expect(kestrel(dir, "init", "newsletter").code).toBe(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("kestrel sync-migrations", () => {
  it("copies in a migration the instance doesn't have yet, by its exact name", () => {
    rmSync(join(migrations, LAST));

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(0);
    expect(r.out).toContain(`added migrations/${LAST}`);
    expect(r.out).not.toContain(`added migrations/${FIRST}`);
    expect(listed()).toEqual(SHIPPED_NAMES);
    expect(theirs(LAST)).toBe(shipped(LAST));
  });

  it("leaves every migration already there and identical alone, and says it has them all", () => {
    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("added");
    expect(r.out).toContain("already has every migration");
    expect(r.err).toBe("");
    expect(listed()).toEqual(SHIPPED_NAMES);
  });

  it("takes a copy with Windows line endings for the same file, not an edited one", () => {
    writeFileSync(join(migrations, FIRST), shipped(FIRST).replace(/\n/g, "\r\n"));

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(theirs(FIRST)).toBe(shipped(FIRST).replace(/\n/g, "\r\n"));
  });

  it("refuses to overwrite a shipped migration that differs, exits 1, and keeps the operator's copy", () => {
    const edited = `${shipped(FIRST)}\n-- an operator's edit\n`;
    writeFileSync(join(migrations, FIRST), edited);

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(1);
    expect(r.err).toContain(`refused to overwrite migrations/${FIRST}`);
    expect(r.err).toContain("local_");
    expect(theirs(FIRST)).toBe(edited);
  });

  it("still copies in the new migrations when it refuses another, so a rerun after the fix finishes the job", () => {
    writeFileSync(join(migrations, FIRST), "-- edited\n");
    rmSync(join(migrations, LAST));

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(1);
    expect(r.out).toContain(`added migrations/${LAST}`);
    expect(r.err).toContain(`migrations/${FIRST}`);
    expect(r.err).not.toContain(`migrations/${LAST}`);
    expect(theirs(LAST)).toBe(shipped(LAST));
  });

  it("creates migrations/ when the instance has none, with every shipped migration", () => {
    rmSync(migrations, { recursive: true });

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(0);
    expect(listed()).toEqual(SHIPPED_NAMES);
    for (const name of SHIPPED_NAMES) {
      expect(r.out).toContain(`added migrations/${name}`);
    }
  });

  it("leaves the instance's own migrations alone and never mentions them", () => {
    const own = "local_0001_reader_notes.sql";
    writeFileSync(join(migrations, own), "CREATE TABLE reader_notes (id INTEGER);\n");

    const r = kestrel(instance, "sync-migrations");

    expect(r.code).toBe(0);
    expect(`${r.out}${r.err}`).not.toContain(own);
    expect(theirs(own)).toBe("CREATE TABLE reader_notes (id INTEGER);\n");
  });

  it("copies nothing when migrations/ is the package's own folder, as in Kestrel's repository", () => {
    const own = join(dir, "kestrel-checkout");
    mkdirSync(own);
    symlinkSync(SHIPPED, join(own, "migrations"), "dir");

    const r = kestrel(own, "sync-migrations");

    expect(r.code).toBe(0);
    expect(r.out).toContain("Kestrel's own repository");
    expect(r.out).not.toContain("added");
    expect(existsSync(join(own, "migrations", FIRST))).toBe(true);
  });
});
