/*
 * `kestrel check-context` (cli/context.mjs), the one thing that tells an operator a release
 * changed the Claude context their instance started with. Each context file carries a header
 * naming the release it came from and the hash of that release's copy; the command compares
 * the header's hash, the file now, and the installed release's file, so it tells "Kestrel
 * changed this" apart from "the operator edited this" and never overwrites an edit. Run as an
 * instance's npm script runs it, `bin/kestrel.mjs` in the instance's folder, on an instance
 * the real `kestrel init` wrote into a temp directory (init only copies files, so it is quick
 * and needs no network). The installed release is this checkout, so an older release is made
 * by rewriting a file's header to name one, with the hash of an older copy.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(PACKAGE_ROOT, "bin", "kestrel.mjs");
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
const OLD = "0.9.0";

const CLAUDE_MD = ".claude/CLAUDE.md";
const UPGRADE_SKILL = ".claude/skills/upgrade/SKILL.md";
const MIGRATE_SKILL = ".claude/skills/migrate-list/SKILL.md";
const FILES = [CLAUDE_MD, UPGRADE_SKILL, MIGRATE_SKILL];

// The release's own copy, as it ships.
const RELEASE_BODY = readFileSync(join(PACKAGE_ROOT, "template", "claude", "CLAUDE.md"), "utf8");
// A paragraph only the older release's copy had: Kestrel has changed the file since.
const DROPPED = "\nA paragraph an older release had and this one dropped.\n";
const OPERATOR = "\nAlways sign posts as the Windbreak team.\n";

const HEADER = /@kurtbruns\/kestrel (\S+), sha256:([0-9a-f]{64})/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Run `kestrel <args>` in `cwd`, as an instance's npm script does. */
const kestrel = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let dir;
let instance;
let asInitWrote;
const path = (file) => join(instance, file);
const theirs = (file) => readFileSync(path(file), "utf8");
const put = (file, text) => writeFileSync(path(file), text);
/** The line check-context prints for `file`. */
const lineFor = (out, file) =>
  out.split("\n").find((l) => l.startsWith(`[check-context] ${file}:`));

/**
 * `file` with a header naming an older release whose copy was `body`, and `text` below it:
 * that copy itself unless the operator has since changed it.
 */
const fromOlderRelease = (file, body, text = body) => {
  const lines = asInitWrote[file].split("\n");
  const at = lines.findIndex((l) => HEADER.test(l));
  lines[at] = lines[at].replace(HEADER, `@kurtbruns/kestrel ${OLD}, sha256:${sha256(body)}`);
  // CLAUDE.md's header is its first line, above the body; a skill's sits inside its front
  // matter, so only CLAUDE.md is given an older body here.
  expect(file).toBe(CLAUDE_MD);
  return `${lines[at]}\n${text}`;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-check-context-"));
  instance = join(dir, "newsletter");
  expect(kestrel(dir, "init", "newsletter").code).toBe(0);
  asInitWrote = Object.fromEntries(FILES.map((f) => [f, theirs(f)]));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("kestrel check-context", () => {
  it("reports every file current on a fresh instance, exits 0, and asks for nothing", () => {
    const r = kestrel(instance, "check-context");

    expect(r.code).toBe(0);
    for (const file of FILES) {
      expect(lineFor(r.out, file)).toBe(`[check-context] ${file}: current`);
    }
    expect(r.out).not.toContain("changelog");
  });

  it("reads a checkout with Windows line endings as the same file, not an edit", () => {
    put(CLAUDE_MD, asInitWrote[CLAUDE_MD].replace(/\n/g, "\r\n"));

    const r = kestrel(instance, "check-context");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toBe(`[check-context] ${CLAUDE_MD}: current`);
  });

  it("reports a file the release changed and the operator never edited, and --update takes the release's", () => {
    const old = fromOlderRelease(CLAUDE_MD, `${RELEASE_BODY}${DROPPED}`);
    put(CLAUDE_MD, old);

    const r = kestrel(instance, "check-context");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toContain(`changed it (yours came from ${OLD})`);
    expect(lineFor(r.out, CLAUDE_MD)).toContain("haven't edited it");
    expect(r.out).toContain("--update");
    expect(r.out).toContain("changelog");
    expect(theirs(CLAUDE_MD)).toBe(old);

    const u = kestrel(instance, "check-context", "--update");

    expect(u.code).toBe(0);
    expect(lineFor(u.out, CLAUDE_MD)).toContain(`updated to ${VERSION}`);
    expect(theirs(CLAUDE_MD)).toBe(asInitWrote[CLAUDE_MD]);
  });

  it("reports a file the release changed and the operator edited with the difference, and --update never overwrites it", () => {
    const older = `${RELEASE_BODY}${DROPPED}`;
    const edited = fromOlderRelease(CLAUDE_MD, older, older + OPERATOR);
    put(CLAUDE_MD, edited);

    const r = kestrel(instance, "check-context");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toContain("you've edited it");
    // The diff runs from theirs to the release's, so their edit shows as a removed line.
    expect(r.out).toContain(`-${OPERATOR.trim()}`);
    expect(r.out).toContain(`--merged ${CLAUDE_MD}`);
    expect(r.out).toContain("changelog");

    const u = kestrel(instance, "check-context", "--update");

    expect(u.code).toBe(0);
    expect(lineFor(u.out, CLAUDE_MD)).toContain("you've edited it");
    expect(theirs(CLAUDE_MD)).toBe(edited);
  });

  it("records a merge with --merged, keeping the operator's text, so the file then reads current with their edits", () => {
    // Their edit kept, and the release's change (the dropped paragraph) taken.
    const merged = `${RELEASE_BODY}${OPERATOR}`;
    put(CLAUDE_MD, fromOlderRelease(CLAUDE_MD, `${RELEASE_BODY}${DROPPED}`, merged));

    const m = kestrel(instance, "check-context", "--merged", CLAUDE_MD);

    expect(m.code).toBe(0);
    expect(m.out).toContain(`recorded as merged with ${VERSION}`);
    expect(theirs(CLAUDE_MD).endsWith(merged)).toBe(true);
    expect(HEADER.exec(theirs(CLAUDE_MD)).slice(1)).toEqual([VERSION, sha256(RELEASE_BODY)]);

    const r = kestrel(instance, "check-context");

    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: current, with your edits`,
    );
    expect(r.out).not.toContain("changelog");
  });

  it("refuses --merged for a file that isn't a context file, exiting 1 and writing nothing", () => {
    const r = kestrel(instance, "check-context", "--merged", "README.md");

    expect(r.code).toBe(1);
    expect(r.err).toContain(`--merged takes one of: ${FILES.join(", ")}`);
    for (const file of FILES) {
      expect(theirs(file)).toBe(asInitWrote[file]);
    }
  });

  it("reports a file the operator edited where the release changed nothing as current, and --update leaves it", () => {
    const edited = asInitWrote[CLAUDE_MD] + OPERATOR;
    put(CLAUDE_MD, edited);

    const r = kestrel(instance, "check-context", "--update");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: current, with your edits`,
    );
    expect(r.out).not.toContain("changelog");
    expect(theirs(CLAUDE_MD)).toBe(edited);
  });

  it("reports a file that already has the release's text under an older header as current, and --update restamps it", () => {
    // The operator took the release's text by hand, so only the header is behind.
    put(CLAUDE_MD, fromOlderRelease(CLAUDE_MD, `${RELEASE_BODY}${DROPPED}`, RELEASE_BODY));

    const r = kestrel(instance, "check-context");

    expect(lineFor(r.out, CLAUDE_MD)).toBe(`[check-context] ${CLAUDE_MD}: current`);
    expect(HEADER.exec(theirs(CLAUDE_MD))[1]).toBe(OLD);

    kestrel(instance, "check-context", "--update");

    expect(theirs(CLAUDE_MD)).toBe(asInitWrote[CLAUDE_MD]);
  });

  it("can't tell edits from Kestrel's changes in a file with no header, so shows the difference and keeps it", () => {
    const headless = `${RELEASE_BODY}${OPERATOR}`;
    put(CLAUDE_MD, headless);

    const r = kestrel(instance, "check-context", "--update");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toContain("no Kestrel header");
    expect(r.out).toContain(`-${OPERATOR.trim()}`);
    expect(r.out).toContain(`--merged ${CLAUDE_MD}`);
    expect(theirs(CLAUDE_MD)).toBe(headless);
  });

  it("reports a file the release ships that the instance lacks, and --update writes it", () => {
    rmSync(path(MIGRATE_SKILL));

    const r = kestrel(instance, "check-context");

    expect(r.code).toBe(0);
    expect(lineFor(r.out, MIGRATE_SKILL)).toContain("missing");
    expect(existsSync(path(MIGRATE_SKILL))).toBe(false);

    const u = kestrel(instance, "check-context", "--update");

    expect(lineFor(u.out, MIGRATE_SKILL)).toContain(`restored from ${VERSION}`);
    expect(theirs(MIGRATE_SKILL)).toBe(asInitWrote[MIGRATE_SKILL]);
  });

  it("leaves Claude files the release doesn't ship alone, and never mentions them", () => {
    const own = ".claude/skills/house-style/SKILL.md";
    mkdirSync(dirname(path(own)), { recursive: true });
    put(own, "---\nname: house-style\n---\nOur style.\n");

    const r = kestrel(instance, "check-context", "--update");

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("house-style");
    expect(theirs(own)).toBe("---\nname: house-style\n---\nOur style.\n");
  });
});
