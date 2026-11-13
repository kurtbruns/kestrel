/*
 * The Claude context an instance starts with, and `kestrel check-context`, which shows the
 * operator what a release changed in it.
 *
 * `kestrel init` writes the files below into the instance. From then on they are the
 * operator's, like a config file: they may edit them freely, and an upgrade never overwrites
 * an edit. The check keeps no record of its own. The releases on npm are the record: the
 * release the operator upgraded from (the one their last commit's package.json pins, or
 * `--from`) is the base, and the check compares three copies of each file, the base release's,
 * the installed release's, and the operator's.
 *
 *   theirs is the installed release's              current
 *   Kestrel's unchanged between the two releases   current, with their edits
 *   theirs is the base release's, unedited         `--update` takes the installed release's
 *   theirs is gone, and the base release had it    left out: the operator removed it
 *   theirs is gone, and the base release didn't    new in this release; `--update` adds it
 *   both changed                                   shows Kestrel's change (base to installed)
 *                                                  and then theirs (base to theirs), for them
 *                                                  or Claude to merge
 *
 * The base is fetched from npm only when a file differs from the installed copy (`npm pack`, in
 * a temp directory, no package script run, then the system `tar` extracting only
 * `template/claude/` into that directory, which is removed after). Without npm's answer, tar,
 * git, or a release to start from, the check shows one diff from the operator's file to the
 * installed release's, says why, and `--update` leaves the file alone, since nothing then says
 * it is unedited.
 *
 * A change the operator didn't take at the upgrade it came in isn't offered again: the next
 * upgrade's base is the release they were on, which already had it.
 *
 * An upgrade can skip releases, so the base may be several releases back. When there is a change
 * to take, the closing line names that range of changelog sections, since each section counts
 * only its own release's changes.
 *
 * Releases before this one wrote a header line into each file, naming the release and a hash,
 * which Claude read in every session. The first run under this release removes that line, and
 * nothing else, from each file (`stripHeaders`), and says so in one line after every file's
 * answer.
 *
 * The files ship under `template/claude/` and land in `.claude/`: shipped under `.claude/`,
 * they would load into a Claude session working in Kestrel's own repository as context and
 * skills of its own.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

/** The context files an instance gets, by their path in the instance. */
export const CONTEXT_FILES = [
  ".claude/CLAUDE.md",
  ".claude/skills/upgrade/SKILL.md",
  ".claude/skills/migrate-list/SKILL.md",
];

/** Where an instance's context file ships in the package. */
export function shippedPath(file) {
  return join(PACKAGE_ROOT, "template", file.replace(/^\.claude\//, "claude/"));
}

// Files are compared with LF line endings, so a checkout that turns them into CRLF (git's
// autocrlf on Windows) reads as the same file, not as an edit.
const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (path) => lf(readFileSync(path, "utf8"));
const shipped = (file) => read(shippedPath(file));

// How an operator runs this command: `kestrel` is on the PATH only inside an npm script.
const RUN = "npm run check-context --";
const say = (line) => console.log(`[check-context] ${line}`);

// How long npm gets to fetch the base release before the check falls back.
const NPM_TIMEOUT_MS = 60_000;
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Write the release's copy of a context file into the instance at `root`. */
export function writeShipped(root, file) {
  const to = join(root, file);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, shipped(file));
}

// The header releases before this one wrote: a Markdown file's first line, and in a skill, a
// YAML comment inside its front matter. Read on any line, as those releases read it.
const HEADER = /@kurtbruns\/kestrel \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?, sha256:[0-9a-f]{64}\b/;
// Anything that looks like one, so a header an edit has damaged is left alone, not missed.
const HEADER_LIKE = /@kurtbruns\/kestrel\b.*sha256:/;

/**
 * A file's text with its header line removed and every other byte as it was; `{ unreadable }`
 * (line numbers) when a line looks like a header but isn't one, or there is more than one;
 * null when there is none.
 */
export function withoutHeader(raw) {
  const lines = raw.split("\n");
  const like = lines.flatMap((line, i) => (HEADER_LIKE.test(line) ? [i] : []));
  if (like.length === 0) {
    return null;
  }
  if (like.length > 1 || !HEADER.test(lines[like[0]])) {
    return { unreadable: like.map((i) => i + 1) };
  }
  // The line goes with the newline that ended it, so the text below moves up untouched.
  lines.splice(like[0], 1);
  return { text: lines.join("\n") };
}

/**
 * Remove the header line earlier releases wrote from each file that has one. Prints nothing:
 * the count and the lines about headers it couldn't read are said after every file's answer, so
 * the first lines a run prints are what it found, not a note about a line it removed.
 */
function stripHeaders(root) {
  let stripped = 0;
  const unreadable = [];
  for (const file of CONTEXT_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    const h = withoutHeader(readFileSync(path, "utf8"));
    if (h?.unreadable) {
      unreadable.push(
        `${file}: line ${h.unreadable.join(" and ")} looks like the header line earlier releases wrote, but isn't one check-context can read, so the file is left as it is. Delete that line yourself.`,
      );
    } else if (h) {
      writeFileSync(path, h.text);
      stripped++;
    }
  }
  return { stripped, unreadable };
}

/**
 * The release the operator upgraded from: `--from`, else the version of this package their
 * last commit's package.json pins. `{ version }`, or `{ error }` saying why there is none.
 */
function baseRelease(root, argv) {
  const at = argv.indexOf("--from");
  if (at !== -1) {
    const version = argv[at + 1] ?? "";
    return RELEASE.test(version)
      ? { version }
      : { error: `--from takes a release, like 1.20.0, not "${version}"` };
  }
  const r = spawnSync("git", ["show", "HEAD:./package.json"], { cwd: root, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return { error: "no commit here has a package.json naming the release you upgraded from" };
  }
  let pinned;
  try {
    pinned = JSON.parse(r.stdout).dependencies?.[PACKAGE.name];
  } catch {
    return { error: "the package.json in your last commit isn't JSON check-context can read" };
  }
  const version = `${pinned ?? ""}`.replace(/^[=v^~]+/, "");
  return RELEASE.test(version)
    ? { version }
    : { error: `the package.json in your last commit doesn't pin one release of ${PACKAGE.name}` };
}

/** Whether git can be run here, for the diffs. */
function hasGit() {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * The unified diff from `from` to `to`, each `[label, text]`, the label naming its side in the
 * diff's file names (`kestrel-1.17.0/CLAUDE.md`); null when git can't run.
 */
function diff(name, [fromLabel, fromText], [toLabel, toText]) {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-context-"));
  try {
    for (const [label, text] of [
      [fromLabel, fromText],
      [toLabel, toText],
    ]) {
      mkdirSync(join(dir, label));
      writeFileSync(join(dir, label, name), text);
    }
    const r = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-prefix",
        `${fromLabel}/${name}`,
        `${toLabel}/${name}`,
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // `git diff --no-index` exits 1 when the files differ, with the diff on stdout.
    return r.status === 0 ? "" : r.status === 1 ? r.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How to run npm: through npm's own CLI script when an npm script started us, as on Windows. */
function npm(args, options) {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.c?js$/.test(cli)) {
    return spawnSync(process.execPath, [cli, ...args], options);
  }
  return spawnSync("npm", args, options);
}

/**
 * Release `version`'s `template/claude/` files from npm, by their path in an instance, or
 * `{ error }` saying why they couldn't be had.
 */
function fetchRelease(version) {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-release-"));
  try {
    const r = npm(
      ["pack", "--ignore-scripts", "--pack-destination", dir, `${PACKAGE.name}@${version}`],
      { cwd: dir, encoding: "utf8", timeout: NPM_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.error?.code === "ETIMEDOUT") {
      return { error: `npm didn't fetch ${version} within ${NPM_TIMEOUT_MS / 1000} seconds` };
    }
    if (r.error) {
      return { error: `npm couldn't be run (${r.error.message})` };
    }
    if (r.status !== 0) {
      const said = `${r.stderr}`;
      if (/E404|ETARGET|No matching version/.test(said)) {
        return { error: `npm has no ${PACKAGE.name}@${version}` };
      }
      const last = said.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.status}`;
      return { error: `npm couldn't fetch ${version} (${last.trim()})` };
    }
    const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      return { error: `npm pack left no tarball for ${version}` };
    }
    // The system tar, which macOS, Linux and Windows 10 and later ship (`tar.exe` there, same
    // flags), extracts only `template/claude/` into the temp directory; without it there is no
    // base, as without the network.
    const out = join(dir, "release");
    mkdirSync(out);
    const t = spawnSync("tar", ["-xzf", join(dir, tgz), "-C", out, "package/template/claude"], {
      encoding: "utf8",
      timeout: NPM_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (t.error) {
      return {
        error:
          t.error.code === "ENOENT"
            ? "tar isn't installed"
            : `tar couldn't be run (${t.error.message})`,
      };
    }
    if (t.status !== 0) {
      const last = `${t.stderr}`.trim().split("\n").filter(Boolean).pop() ?? `exit ${t.status}`;
      return { error: `tar couldn't read ${version}'s package (${last.trim()})` };
    }
    // Only the known files are read back, each a regular file that resolves inside the temp
    // directory, so a link in the tarball can't point the read anywhere else.
    const inside = `${realpathSync(out)}${sep}`;
    const files = new Map();
    for (const file of CONTEXT_FILES) {
      const path = join(out, "package", "template", file.replace(/^\.claude\//, "claude/"));
      if (existsSync(path) && lstatSync(path).isFile() && realpathSync(path).startsWith(inside)) {
        files.set(file, read(path));
      }
    }
    return { files };
  } catch (err) {
    return { error: `${version}'s package couldn't be read (${err.message})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single diff from the operator's file to the release's, when there is no base. */
/** `git` is the run's lazy check for git, called only here, when there is a diff to make. */
function reportOneDiff(file, mine, git) {
  const d = git()
    ? diff(basename(file), ["yours", mine], [`kestrel-${PACKAGE.version}`, shipped(file)])
    : null;
  console.log(
    d === null
      ? `  Compare it with ${shippedPath(file)}.`
      : `  From yours to ${PACKAGE.version}'s (lines starting + are the release's):\n${d}`,
  );
  console.log("  Merge what you want of it into yours, by hand or with Claude.");
}

/** `kestrel check-context [--update] [--from <release>]`. */
export function checkContextCommand(argv, root = process.cwd()) {
  const { stripped, unreadable } = stripHeaders(root);
  try {
    answerEachFile(argv, root);
  } finally {
    // Said once, after every file's answer, and never "nothing else changed": a file it touched
    // may be one Kestrel changed in this release, which its own line says. Said even when an
    // answer fails partway, since the headers are already gone by then.
    for (const line of unreadable) {
      say(line);
    }
    if (stripped > 0) {
      say(
        `Removed the header line earlier releases wrote from ${stripped === 1 ? "1 file" : `${stripped} files`}, and only that line: this release keeps no record in the files, since it compares them with the releases on npm. Commit that with the upgrade.`,
      );
    }
  }
}

/** Say, for each context file, how it stands against the release, and with --update take it. */
function answerEachFile(argv, root) {
  if (argv.includes("--merged")) {
    // Older upgrade skills run this after a merge; the merge is the record now.
    say(
      "--merged has nothing to record any more: check-context compares your files with the release you upgraded from, so once you commit the merge, it stands.",
    );
    return;
  }

  const update = argv.includes("--update");
  // Git and the base are looked for once, and only when a file differs from the installed copy.
  let gitFound = null;
  const git = () => {
    gitFound ??= hasGit();
    return gitFound;
  };
  let from = null;
  let release = null;
  const base = () => {
    if (from === null) {
      from = git() ? baseRelease(root, argv) : { error: "git isn't installed" };
      if (from.version && from.version !== PACKAGE.version) {
        release = fetchRelease(from.version);
      }
    }
    return from;
  };

  let pending = 0;
  for (const file of CONTEXT_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      // A file the base release shipped was removed by the operator, which is theirs to do; one
      // it didn't ship is new in this release. Without a base the two can't be told apart.
      const b = base();
      const error =
        b.error ??
        (b.version === PACKAGE.version
          ? `your last commit already names ${PACKAGE.version}`
          : release.error);
      if (error) {
        say(
          `${file}: not here, and it can't be told whether you removed it or ${PACKAGE.version} adds it: ${error}. If you want it, copy ${shippedPath(file)}.`,
        );
      } else if (release.files.has(file)) {
        const changed = release.files.get(file) !== shipped(file);
        say(
          `${file}: you removed it, so it's left out${changed ? `; Kestrel changed it between ${b.version} and ${PACKAGE.version}` : ""}. To bring it back, copy ${shippedPath(file)}, or ask Claude to.`,
        );
      } else if (update) {
        writeShipped(root, file);
        say(`${file}: added from ${PACKAGE.version}`);
      } else {
        pending++;
        say(`${file}: new in ${PACKAGE.version}; \`${RUN} --update\` adds it`);
      }
      continue;
    }
    const mine = read(path);
    const installed = shipped(file);
    if (mine === installed) {
      say(`${file}: current`);
      continue;
    }
    const b = base();
    if (b.version === PACKAGE.version) {
      pending++;
      say(
        `${file}: differs from ${PACKAGE.version}'s, and there's no earlier release to compare it with: your last commit already names ${PACKAGE.version}. If you've committed an upgrade, \`${RUN} --from <release>\` shows what Kestrel changed since the release you came from.`,
      );
      reportOneDiff(file, mine, git);
      continue;
    }
    const error = b.error ?? release.error;
    const old = error ? undefined : release.files.get(file);
    if (error || old === undefined) {
      pending++;
      say(
        `${file}: differs from ${PACKAGE.version}'s, and Kestrel's change can't be shown apart from your edits: ${error ?? `${b.version} didn't ship it`}.`,
      );
      if (b.error) {
        console.log(`  Name the release you upgraded from with \`${RUN} --from <release>\`.`);
      }
      reportOneDiff(file, mine, git);
      continue;
    }
    if (old === installed) {
      say(`${file}: current, with your edits (Kestrel's copy unchanged since ${b.version})`);
      continue;
    }
    if (mine === old) {
      if (update) {
        writeShipped(root, file);
        say(`${file}: updated from ${b.version}'s to ${PACKAGE.version}'s`);
      } else {
        pending++;
        say(
          `${file}: Kestrel changed it between ${b.version} and ${PACKAGE.version}, and you haven't edited it; \`${RUN} --update\` takes ${PACKAGE.version}'s`,
        );
      }
      continue;
    }
    pending++;
    const name = basename(file);
    const [baseLabel, installedLabel] = [`kestrel-${b.version}`, `kestrel-${PACKAGE.version}`];
    say(
      `${file}: Kestrel changed it between ${b.version} and ${PACKAGE.version}, and you've edited it.`,
    );
    const kestrels = diff(name, [baseLabel, old], [installedLabel, installed]);
    const yours = diff(name, [baseLabel, old], ["yours", mine]);
    if (kestrels === null || yours === null) {
      console.log(
        `  git couldn't compare the copies, so Kestrel's change can't be shown apart from your edits. Compare yours with ${shippedPath(file)}.`,
      );
      console.log("  Merge what you want of it into yours, by hand or with Claude.");
      continue;
    }
    console.log(`  What Kestrel changed, from ${b.version}'s copy to ${PACKAGE.version}'s:`);
    console.log(kestrels);
    console.log(`  Your edits, from ${b.version}'s copy to yours:`);
    console.log(yours);
    console.log(
      "  Merge Kestrel's change into yours, keeping your edits; Claude can, from the two differences above.",
    );
  }
  if (pending > 0) {
    // Named as a range, since a changelog section counts only its own release's changes: an
    // upgrade that skips releases can see more files here than the target's section names.
    const since = from?.version && from.version !== PACKAGE.version ? from.version : null;
    say(
      since
        ? `The changelog says what changed in Claude's context and why, and marks a change that bears on safety, in its sections for each release after ${since} up to ${PACKAGE.version}.`
        : "The changelog says what changed in Claude's context and why, and marks a change that bears on safety.",
    );
  }
}
