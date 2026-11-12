/*
 * `kestrel check-context` (cli/context.mjs), which shows an operator what a release changed in
 * the Claude context their instance started with. It keeps no record: it compares each file
 * with the copy the installed release ships and, where they differ, with the copy of the
 * release the operator upgraded from (the one their last commit's package.json pins, fetched
 * from npm), so it tells "Kestrel changed this" apart from "the operator edited this" and never
 * overwrites an edit. Run as an instance's npm script runs it, `bin/kestrel.mjs` in the
 * instance's folder, on an instance the real `kestrel init` wrote into a temp directory. The
 * installed release is this checkout; an older one is a release published to a fake npm.
 *
 * No spec reaches npm: every run gets `npm_execpath` (npm's own variable, which the command
 * runs npm through) pointing at a fake npm that hands back tarballs built here, or fails.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_FILES } from "../../cli/context.mjs";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(PACKAGE_ROOT, "bin", "kestrel.mjs");
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
const OLD = "0.9.0";

const CLAUDE_MD = ".claude/CLAUDE.md";
const UPGRADE_SKILL = ".claude/skills/upgrade/SKILL.md";
const MIGRATE_SKILL = ".claude/skills/migrate-list/SKILL.md";
const FILES = [CLAUDE_MD, UPGRADE_SKILL, MIGRATE_SKILL];

// Each file's text as this release ships it.
const RELEASE = Object.fromEntries(
  FILES.map((f) => [
    f,
    readFileSync(join(PACKAGE_ROOT, "template", f.replace(/^\.claude\//, "claude/")), "utf8"),
  ]),
);
// A paragraph only the older release's copy had: Kestrel has changed the file since.
const DROPPED = "\nA paragraph an older release had and this one dropped.\n";
const older = (file) => `${RELEASE[file]}${DROPPED}`;
const OPERATOR = "\nAlways sign posts as the Windbreak team.\n";

// The header lines exactly as every release from check-context's first (1.5.0) to the last
// before this one wrote them, read off live instances and `git show v1.22.0:cli/context.mjs`:
// a Markdown file's first line, and in a skill, the second line of its front matter. Instances
// in the wild carry these, so the command has to remove them.
const RELEASED_HEADER = {
  markdown: (version, hash) =>
    `<!-- @kurtbruns/kestrel ${version}, sha256:${hash}. Kestrel check-context compares against this line; your edits are yours. -->`,
  skill: (version, hash) =>
    `# @kurtbruns/kestrel ${version}, sha256:${hash} (kestrel check-context compares against this line)`,
};
/** The one line a run that removed headers from `count` prints about it, after every file's. */
const REMOVED = (count) =>
  `Removed the header line earlier releases wrote from ${count}, and only that line: this release keeps no record in the files, since it compares them with the releases on npm. Commit that with the upgrade.`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** `text` with the header a release `version` wrote into it. */
const withHeader = (text, version) =>
  text.startsWith("---\n")
    ? `---\n${RELEASED_HEADER.skill(version, sha256(text))}\n${text.slice(4)}`
    : `${RELEASED_HEADER.markdown(version, sha256(text))}\n${text}`;

let dir;
let instance;
let npmDir;
const path = (file) => join(instance, file);
const theirs = (file) => readFileSync(path(file), "utf8");
const put = (file, text) => writeFileSync(path(file), text);
/** The line check-context prints for `file`'s state: its first, before any about its header. */
const lineFor = (out, file) =>
  out.split("\n").find((l) => l.startsWith(`[check-context] ${file}:`));
const npmCalls = () =>
  existsSync(join(npmDir, "calls")) ? readFileSync(join(npmDir, "calls"), "utf8") : "";

// A fake npm: `pack` copies `<version>.tgz` from its folder to `--pack-destination`, and
// otherwise fails as npm does offline, or, with FAKE_NPM=404, as npm does for a missing version.
const FAKE_NPM = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls"), args.join(" ") + "\\n");
const version = args.at(-1).split("@").at(-1);
const tgz = path.join(__dirname, version + ".tgz");
if (fs.existsSync(tgz)) {
  fs.copyFileSync(tgz, path.join(args[args.indexOf("--pack-destination") + 1], "kurtbruns-kestrel-" + version + ".tgz"));
} else if (process.env.FAKE_NPM === "404") {
  console.error("npm error code ETARGET\\nnpm error notarget No matching version found for @kurtbruns/kestrel@" + version + ".");
  process.exit(1);
} else {
  console.error("npm error code ENOTFOUND\\nnpm error network request to https://registry.npmjs.org/@kurtbruns%2fkestrel failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org");
  process.exit(1);
}
`;

/** Publish, to the fake npm, a release `version` whose context files are `files`. */
const publish = (version, files) => {
  const build = mkdtempSync(join(dir, "pack-"));
  for (const [file, text] of Object.entries(files)) {
    const to = join(build, "package", "template", file.replace(/^\.claude\//, "claude/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
  }
  const r = spawnSync("tar", ["-czf", join(npmDir, `${version}.tgz`), "package"], {
    cwd: build,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(r.status).toBe(0);
};
/** The older release, whose copies are this release's plus the dropped paragraph. */
const publishOld = () => publish(OLD, Object.fromEntries(FILES.map((f) => [f, older(f)])));

/** Run `kestrel <args>` in `cwd`, as an instance's npm script does. */
const kestrel = (cwd, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_execpath: join(npmDir, "npm-cli.js"), FAKE_NPM: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const check = (...args) => kestrel(instance, ["check-context", ...args]);
const git = (...args) =>
  spawnSync("git", ["-c", "user.name=Op", "-c", "user.email=op@example.com", ...args], {
    cwd: instance,
    encoding: "utf8",
  });
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
/**
 * A PATH whose `git` logs each call to `<dir>/git-calls` and runs the real one, except that
 * with `failDiff` its `diff` exits 2, as git does on an error, and with `broken` every call,
 * `--version` included, exits 1.
 */
const wrappedGit = (failDiff = false, broken = false) => {
  const bin = mkdtempSync(join(dir, "git-"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho "$1" >> "${bin}/git-calls"\n${broken ? "exit 1\n" : ""}${failDiff ? 'if [ "$1" = diff ]; then exit 2; fi\n' : ""}exec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );
  return {
    PATH: `${bin}:${process.env.PATH}`,
    calls: () =>
      existsSync(join(bin, "git-calls")) ? readFileSync(join(bin, "git-calls"), "utf8") : "",
  };
};
/** Pin `version` in package.json in a commit, then install this release over it, as an upgrade does. */
const upgradedFrom = (version) => {
  const pkg = JSON.parse(theirs("package.json"));
  put(
    "package.json",
    JSON.stringify({
      ...pkg,
      dependencies: { ...pkg.dependencies, "@kurtbruns/kestrel": version },
    }),
  );
  expect(git("init", "-q").status).toBe(0);
  git("add", "-A");
  expect(git("commit", "-qm", "before the upgrade").status).toBe(0);
  put("package.json", JSON.stringify(pkg));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-check-context-"));
  npmDir = join(dir, "npm");
  mkdirSync(npmDir);
  writeFileSync(join(npmDir, "npm-cli.js"), FAKE_NPM);
  instance = join(dir, "newsletter");
  expect(kestrel(dir, ["init", "newsletter"]).code).toBe(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("kestrel init's context", () => {
  it("writes each file as the release ships it, with no header line", () => {
    for (const file of FILES) {
      expect(theirs(file)).toBe(RELEASE[file]);
    }
  });
});

describe("kestrel check-context", () => {
  it("reports every file current on a fresh instance, exits 0, and asks npm for nothing", () => {
    const r = check();

    expect(r.code).toBe(0);
    for (const file of FILES) {
      expect(lineFor(r.out, file)).toBe(`[check-context] ${file}: current`);
    }
    expect(r.out).not.toContain("changelog");
    expect(npmCalls()).toBe("");
  });

  it("asks neither git nor npm for anything on an upgrade where every file already has the release's copy", () => {
    upgradedFrom(OLD);
    const gitWrapper = wrappedGit();

    const r = kestrel(instance, ["check-context"], { PATH: gitWrapper.PATH });

    expect(r.out.trim().split("\n")).toEqual(FILES.map((f) => `[check-context] ${f}: current`));
    expect(npmCalls()).toBe("");
    expect(gitWrapper.calls()).toBe("");
  });

  it("reads a checkout with Windows line endings as the same file, not an edit", () => {
    put(CLAUDE_MD, RELEASE[CLAUDE_MD].replace(/\n/g, "\r\n"));

    const r = check();

    expect(lineFor(r.out, CLAUDE_MD)).toBe(`[check-context] ${CLAUDE_MD}: current`);
  });

  it("reports a file Kestrel changed since the release upgraded from and the operator never edited, and --update takes the new one", () => {
    publishOld();
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(OLD);

    const r = check();

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: Kestrel changed it between ${OLD} and ${VERSION}, and you haven't edited it; \`npm run check-context -- --update\` takes ${VERSION}'s`,
    );
    expect(r.out).toContain("changelog");
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD));
    expect(npmCalls()).toMatch(
      new RegExp(`^pack --ignore-scripts --pack-destination \\S+ @kurtbruns/kestrel@${OLD}\n$`),
    );

    const u = check("--update");

    expect(lineFor(u.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: updated from ${OLD}'s to ${VERSION}'s`,
    );
    expect(theirs(CLAUDE_MD)).toBe(RELEASE[CLAUDE_MD]);
  });

  it("shows what Kestrel changed, then the operator's own edits, for a file both changed, and --update never overwrites it", () => {
    publishOld();
    const edited = older(CLAUDE_MD) + OPERATOR;
    put(CLAUDE_MD, edited);
    upgradedFrom(OLD);

    const r = check();

    expect(r.code).toBe(0);
    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: Kestrel changed it between ${OLD} and ${VERSION}, and you've edited it.`,
    );
    const kestrels = r.out.indexOf(`What Kestrel changed, from ${OLD}'s copy to ${VERSION}'s:`);
    const yours = r.out.indexOf(`Your edits, from ${OLD}'s copy to yours:`);
    expect(kestrels).toBeGreaterThan(-1);
    expect(yours).toBeGreaterThan(kestrels);
    // Kestrel's change is the dropped paragraph alone; the operator's is their line alone.
    const kestrelDiff = r.out.slice(kestrels, yours);
    expect(kestrelDiff).toContain(`-${DROPPED.trim()}`);
    expect(kestrelDiff).not.toContain(OPERATOR.trim());
    const yourDiff = r.out.slice(yours);
    expect(yourDiff).toContain(`+${OPERATOR.trim()}`);
    expect(yourDiff).not.toContain(`-${DROPPED.trim()}`);
    expect(r.out).toContain(
      "Merge Kestrel's change into yours, keeping your edits; Claude can, from the two differences above.",
    );

    const u = check("--update");

    expect(lineFor(u.out, CLAUDE_MD)).toContain("you've edited it");
    expect(theirs(CLAUDE_MD)).toBe(edited);
  });

  it("reports a file the operator edited where Kestrel changed nothing between the releases as current, and --update leaves it", () => {
    publish(OLD, RELEASE);
    const edited = RELEASE[CLAUDE_MD] + OPERATOR;
    put(CLAUDE_MD, edited);
    upgradedFrom(OLD);

    const r = check("--update");

    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: current, with your edits (Kestrel's copy unchanged since ${OLD})`,
    );
    expect(r.out).not.toContain("changelog");
    expect(theirs(CLAUDE_MD)).toBe(edited);
  });

  it("says a file differs, with no earlier release to compare it with, where the last commit already names this release, and keeps it", () => {
    // An older copy, never edited, reads the same: nothing here can tell the two apart.
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(VERSION);

    const r = check("--update");

    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: differs from ${VERSION}'s, and there's no earlier release to compare it with: your last commit already names ${VERSION}. If you've committed an upgrade, \`npm run check-context -- --from <release>\` shows what Kestrel changed since the release you came from.`,
    );
    expect(r.out).toContain(`-${DROPPED.trim()}`);
    expect(r.out).toContain("changelog");
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD));
    expect(npmCalls()).toBe("");
  });

  it("compares from the release --from names, over the one the last commit pins", () => {
    publishOld();
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(VERSION);

    const r = check("--from", OLD);

    expect(lineFor(r.out, CLAUDE_MD)).toContain(
      `Kestrel changed it between ${OLD} and ${VERSION}, and you haven't edited it`,
    );
  });

  it("reports a file new in this release, one the release upgraded from didn't ship, and --update adds it", () => {
    publish(OLD, { [CLAUDE_MD]: RELEASE[CLAUDE_MD], [UPGRADE_SKILL]: RELEASE[UPGRADE_SKILL] });
    rmSync(path(MIGRATE_SKILL));
    upgradedFrom(OLD);

    const r = check();

    expect(lineFor(r.out, MIGRATE_SKILL)).toBe(
      `[check-context] ${MIGRATE_SKILL}: new in ${VERSION}; \`npm run check-context -- --update\` adds it`,
    );
    expect(r.out).toContain("changelog");
    expect(existsSync(path(MIGRATE_SKILL))).toBe(false);

    const u = check("--update");

    expect(lineFor(u.out, MIGRATE_SKILL)).toBe(
      `[check-context] ${MIGRATE_SKILL}: added from ${VERSION}`,
    );
    expect(theirs(MIGRATE_SKILL)).toBe(RELEASE[MIGRATE_SKILL]);
  });

  it("leaves out a file the operator removed, one the release upgraded from shipped, even on --update", () => {
    publishOld();
    rmSync(path(MIGRATE_SKILL));
    upgradedFrom(OLD);

    const r = check("--update");

    expect(lineFor(r.out, MIGRATE_SKILL)).toBe(
      `[check-context] ${MIGRATE_SKILL}: you removed it, so it's left out; Kestrel changed it between ${OLD} and ${VERSION}. To bring it back, copy ${join(PACKAGE_ROOT, "template", "claude", "skills", "migrate-list", "SKILL.md")}, or ask Claude to.`,
    );
    expect(r.out).not.toContain("changelog");
    expect(existsSync(path(MIGRATE_SKILL))).toBe(false);
  });

  it("leaves out a removed file Kestrel hasn't changed, naming the copy to bring it back", () => {
    publish(OLD, RELEASE);
    rmSync(path(MIGRATE_SKILL));
    upgradedFrom(OLD);

    const r = check();

    expect(lineFor(r.out, MIGRATE_SKILL)).toBe(
      `[check-context] ${MIGRATE_SKILL}: you removed it, so it's left out. To bring it back, copy ${join(PACKAGE_ROOT, "template", "claude", "skills", "migrate-list", "SKILL.md")}, or ask Claude to.`,
    );
  });

  it("leaves out a file that's gone when it can't tell a removal from a new file, saying why", () => {
    rmSync(path(MIGRATE_SKILL));
    upgradedFrom(OLD);

    const r = check("--update");

    expect(lineFor(r.out, MIGRATE_SKILL)).toBe(
      `[check-context] ${MIGRATE_SKILL}: not here, and it can't be told whether you removed it or ${VERSION} adds it: npm couldn't fetch ${OLD} (npm error network request to https://registry.npmjs.org/@kurtbruns%2fkestrel failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org). If you want it, copy ${join(PACKAGE_ROOT, "template", "claude", "skills", "migrate-list", "SKILL.md")}.`,
    );
    expect(existsSync(path(MIGRATE_SKILL))).toBe(false);
  });

  it("leaves Claude files the release doesn't ship alone, and never mentions them", () => {
    const own = ".claude/skills/house-style/SKILL.md";
    mkdirSync(dirname(path(own)), { recursive: true });
    put(own, "---\nname: house-style\n---\nOur style.\n");

    const r = check("--update");

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("house-style");
    expect(theirs(own)).toBe("---\nname: house-style\n---\nOur style.\n");
  });

  it("accepts --merged, which older upgrade skills run, and says there's nothing to record", () => {
    const edited = RELEASE[CLAUDE_MD] + OPERATOR;
    put(CLAUDE_MD, edited);

    const r = check("--merged", CLAUDE_MD);

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "[check-context] --merged has nothing to record any more: check-context compares your files with the release you upgraded from, so once you commit the merge, it stands.\n",
    );
    expect(theirs(CLAUDE_MD)).toBe(edited);
  });
});

describe("kestrel check-context falls back to one difference, and --update leaves the file", () => {
  const expectOneDiff = (out) => {
    expect(out).toContain(`From yours to ${VERSION}'s (lines starting + are the release's):`);
    expect(out).toContain(`-${OPERATOR.trim()}`);
    expect(out).not.toContain("What Kestrel changed");
  };
  const edited = () => put(CLAUDE_MD, older(CLAUDE_MD) + OPERATOR);

  it("without the network, saying npm couldn't fetch the release", () => {
    edited();
    upgradedFrom(OLD);

    const r = check("--update");

    expect(lineFor(r.out, CLAUDE_MD)).toBe(
      `[check-context] ${CLAUDE_MD}: differs from ${VERSION}'s, and Kestrel's change can't be shown apart from your edits: npm couldn't fetch ${OLD} (npm error network request to https://registry.npmjs.org/@kurtbruns%2fkestrel failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org).`,
    );
    expectOneDiff(r.out);
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD) + OPERATOR);
  });

  it("without the network, keeping even an unedited older copy, since nothing then says it's unedited", () => {
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(OLD);

    check("--update");

    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD));
  });

  it("for a release npm doesn't have", () => {
    edited();
    upgradedFrom(OLD);

    const r = kestrel(instance, ["check-context"], { FAKE_NPM: "404" });

    expect(lineFor(r.out, CLAUDE_MD)).toContain(`npm has no @kurtbruns/kestrel@${OLD}.`);
    expectOneDiff(r.out);
  });

  it("for a file the release upgraded from didn't ship", () => {
    publish(OLD, { [UPGRADE_SKILL]: RELEASE[UPGRADE_SKILL] });
    edited();
    upgradedFrom(OLD);

    const r = check();

    expect(lineFor(r.out, CLAUDE_MD)).toContain(`${OLD} didn't ship it.`);
    expectOneDiff(r.out);
  });

  it("with no commit naming the release upgraded from, pointing at --from", () => {
    edited();

    const r = check("--update");

    expect(lineFor(r.out, CLAUDE_MD)).toContain(
      "no commit here has a package.json naming the release you upgraded from.",
    );
    expect(r.out).toContain(
      "Name the release you upgraded from with `npm run check-context -- --from <release>`.",
    );
    expectOneDiff(r.out);
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD) + OPERATOR);
  });

  it("for a --from that isn't a release", () => {
    edited();

    const r = check("--from", "latest");

    expect(lineFor(r.out, CLAUDE_MD)).toContain(
      '--from takes a release, like 1.20.0, not "latest".',
    );
  });

  it("when git can't make the comparison, naming the release's copy instead of printing nothing", () => {
    publishOld();
    edited();
    upgradedFrom(OLD);

    const r = kestrel(instance, ["check-context"], { PATH: wrappedGit(true).PATH });

    expect(lineFor(r.out, CLAUDE_MD)).toContain("and you've edited it.");
    expect(r.out).toContain(
      `git couldn't compare the copies, so Kestrel's change can't be shown apart from your edits. Compare yours with ${join(PACKAGE_ROOT, "template", "claude", "CLAUDE.md")}.`,
    );
    expect(r.out).not.toContain("null");
    expect(r.out).not.toContain("What Kestrel changed");
  });

  it("without git, naming the release's copy to compare with", () => {
    publishOld();
    edited();
    upgradedFrom(OLD);
    const noGit = mkdtempSync(join(dir, "path-"));

    const r = kestrel(instance, ["check-context", "--update"], { PATH: noGit });

    expect(lineFor(r.out, CLAUDE_MD)).toContain("git isn't installed.");
    expect(r.out).toContain(
      `Compare it with ${join(PACKAGE_ROOT, "template", "claude", "CLAUDE.md")}.`,
    );
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD) + OPERATOR);
  });

  it("without tar, keeping even an unedited older copy on --update", () => {
    publishOld();
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(OLD);
    // git, and nothing else: no tar.
    const onlyGit = mkdtempSync(join(dir, "path-"));
    symlinkSync(REAL_GIT, join(onlyGit, "git"));

    const r = kestrel(instance, ["check-context", "--update"], { PATH: onlyGit });

    expect(lineFor(r.out, CLAUDE_MD)).toContain(
      "Kestrel's change can't be shown apart from your edits: tar isn't installed.",
    );
    expect(r.out).toContain(`From yours to ${VERSION}'s`);
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD));
  });

  it("for a file the release's package holds as a link, which it doesn't follow out of the package", () => {
    // The older release's CLAUDE.md is a link to a file outside the package holding its text.
    const outside = join(dir, "outside.md");
    writeFileSync(outside, older(CLAUDE_MD));
    const build = mkdtempSync(join(dir, "pack-"));
    const to = join(build, "package", "template", "claude", "CLAUDE.md");
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(outside, to);
    expect(
      spawnSync("tar", ["-czf", join(npmDir, `${OLD}.tgz`), "package"], {
        cwd: build,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      }).status,
    ).toBe(0);
    put(CLAUDE_MD, older(CLAUDE_MD));
    upgradedFrom(OLD);

    const r = check("--update");

    expect(lineFor(r.out, CLAUDE_MD)).toContain(`${OLD} didn't ship it.`);
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD));
  });

  it("when tar fails, saying what it said", () => {
    publishOld();
    edited();
    upgradedFrom(OLD);
    const failing = mkdtempSync(join(dir, "tar-"));
    writeFileSync(
      join(failing, "tar"),
      "#!/bin/sh\necho 'tar: Error opening archive: Unrecognized archive format' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    const r = kestrel(instance, ["check-context", "--update"], {
      PATH: `${failing}:${process.env.PATH}`,
    });

    expect(lineFor(r.out, CLAUDE_MD)).toContain(
      `tar couldn't read ${OLD}'s package (tar: Error opening archive: Unrecognized archive format).`,
    );
    expectOneDiff(r.out);
    expect(theirs(CLAUDE_MD)).toBe(older(CLAUDE_MD) + OPERATOR);
  });

  it("with a git that can't run, never asking it for a diff", () => {
    publishOld();
    edited();
    upgradedFrom(OLD);
    const broken = wrappedGit(false, true);

    const r = kestrel(instance, ["check-context"], { PATH: broken.PATH });

    expect(lineFor(r.out, CLAUDE_MD)).toContain("git isn't installed.");
    expect(r.out).toContain(
      `Compare it with ${join(PACKAGE_ROOT, "template", "claude", "CLAUDE.md")}.`,
    );
    expect(broken.calls()).toBe("--version\n");
  });
});

describe("kestrel check-context on files with the header line earlier releases wrote", () => {
  it("removes a Markdown header as 1.21.0 wrote it, and nothing else", () => {
    put(CLAUDE_MD, withHeader(RELEASE[CLAUDE_MD], "1.21.0"));

    const r = check();

    expect(r.out.trim().split("\n")).toEqual([
      ...FILES.map((f) => `[check-context] ${f}: current`),
      `[check-context] ${REMOVED("1 file")}`,
    ]);
    expect(theirs(CLAUDE_MD)).toBe(RELEASE[CLAUDE_MD]);
  });

  it("answers for each file first, then notes the header removal once, after them, on a first run after upgrading", () => {
    publishOld();
    for (const file of FILES) {
      put(file, withHeader(older(file), OLD));
    }
    upgradedFrom(OLD);

    const r = check();

    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      ...FILES.map(
        (f) =>
          `[check-context] ${f}: Kestrel changed it between ${OLD} and ${VERSION}, and you haven't edited it; \`npm run check-context -- --update\` takes ${VERSION}'s`,
      ),
      "[check-context] The changelog says what changed in Claude's context and why, and marks a change that bears on safety.",
      `[check-context] ${REMOVED("3 files")}`,
    ]);
    expect(r.out).not.toContain("nothing else");
  });

  it("removes a skill's front-matter header as 1.22.0 wrote it, the front matter still opening the file", () => {
    const edited = RELEASE[UPGRADE_SKILL] + OPERATOR;
    put(UPGRADE_SKILL, withHeader(edited, "1.22.0"));

    check();

    expect(theirs(UPGRADE_SKILL)).toBe(edited);
  });

  it("keeps every other byte, Windows line endings included", () => {
    const crlf = withHeader(RELEASE[CLAUDE_MD], "1.21.0").replace(/\n/g, "\r\n");
    put(CLAUDE_MD, crlf);

    check();

    expect(theirs(CLAUDE_MD)).toBe(crlf.slice(crlf.indexOf("\r\n") + 2));
  });

  it("changes nothing on a second run", () => {
    for (const file of FILES) {
      put(file, withHeader(RELEASE[file] + OPERATOR, "1.22.0"));
    }
    check();
    const after = Object.fromEntries(FILES.map((f) => [f, theirs(f)]));

    const r = check();

    expect(r.out).not.toContain("header line");
    expect(Object.fromEntries(FILES.map((f) => [f, theirs(f)]))).toEqual(after);
  });

  it("still notes the header removal when an answer fails partway through the run", () => {
    publishOld();
    for (const file of [CLAUDE_MD, MIGRATE_SKILL]) {
      put(file, withHeader(RELEASE[file], OLD));
    }
    // A copy --update has to replace but can't write, so the run fails on the second file.
    put(UPGRADE_SKILL, older(UPGRADE_SKILL));
    chmodSync(path(UPGRADE_SKILL), 0o444);
    upgradedFrom(OLD);

    const r = check("--update");

    expect(r.code).not.toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      `[check-context] ${CLAUDE_MD}: current`,
      `[check-context] ${REMOVED("2 files")}`,
    ]);
    expect(theirs(MIGRATE_SKILL)).toBe(RELEASE[MIGRATE_SKILL]);
  });

  it("notes the header removal after --merged's answer too", () => {
    put(CLAUDE_MD, withHeader(RELEASE[CLAUDE_MD], "1.21.0"));

    const r = check("--merged");

    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      "[check-context] --merged has nothing to record any more: check-context compares your files with the release you upgraded from, so once you commit the merge, it stands.",
      `[check-context] ${REMOVED("1 file")}`,
    ]);
    expect(theirs(CLAUDE_MD)).toBe(RELEASE[CLAUDE_MD]);
  });

  it("leaves a file whose header line it can't read as it is, and says so", () => {
    const damaged = withHeader(RELEASE[CLAUDE_MD], "1.21.0").replace(
      /sha256:[0-9a-f]{8}/,
      "sha256:edited!!",
    );
    put(CLAUDE_MD, damaged);

    const r = check("--update");

    const said = r.out.split("\n");
    const warning = said.findIndex((l) =>
      l.startsWith(
        `[check-context] ${CLAUDE_MD}: line 1 looks like the header line earlier releases wrote, but isn't one check-context can read, so the file is left as it is.`,
      ),
    );
    const answer = said.indexOf(lineFor(r.out, CLAUDE_MD));
    expect(answer).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(answer);
    expect(theirs(CLAUDE_MD)).toBe(damaged);
  });
});

describe("the context files the command knows", () => {
  it("are exactly the files template/claude/ ships, so a new one is written by init and checked on upgrade", () => {
    const shipped = join(PACKAGE_ROOT, "template", "claude");
    const files = readdirSync(shipped, { recursive: true })
      .filter((f) => statSync(join(shipped, f)).isFile())
      .map((f) => `.claude/${f.replaceAll("\\", "/")}`)
      .sort();

    expect([...CONTEXT_FILES].sort()).toEqual(files);
    expect(FILES).toEqual(CONTEXT_FILES);
  });
});
