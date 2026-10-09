/*
 * The Claude context an instance starts with, and `kestrel check-context`, which tells the
 * operator when a release changed it.
 *
 * `kestrel init` writes the files below into the instance. From then on they are the
 * operator's, like a config file: they may edit them freely, and an upgrade never overwrites
 * an edit. So each file records where it came from, in a header naming the release and a
 * hash of the file as shipped. Once a newer release is installed npm no longer has the old
 * one, so the header is the baseline that tells "the operator edited this" apart from
 * "Kestrel changed this". The check compares three versions: the header's hash, the file now,
 * and the installed release's file.
 *
 *   Kestrel's file unchanged since the header's   nothing to do, edited or not
 *   changed, and the operator never edited theirs  `--update` takes the release's file
 *   changed, and theirs is edited                  shows the difference; the operator (or
 *                                                  Claude) merges, then `--merged <file>`
 *                                                  records that the file now has this release
 *
 * The files ship under `template/claude/` and land in `.claude/`: shipped under `.claude/`,
 * they would load into a Claude session working in Kestrel's own repository as context and
 * skills of its own.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

/** The context files an instance gets, by their path in the instance. */
export const CONTEXT_FILES = [".claude/CLAUDE.md", ".claude/skills/upgrade/SKILL.md"];

/** Where an instance's context file ships in the package. */
export function shippedPath(file) {
  return join(PACKAGE_ROOT, "template", file.replace(/^\.claude\//, "claude/"));
}

// The header line, as a Markdown comment or, inside a skill's front matter, a YAML one.
const HEADER = /^.*@kurtbruns\/kestrel (\S+), sha256:([0-9a-f]{64}).*\n/m;

// Files are compared and hashed with LF line endings, so a checkout that turns them into CRLF
// (git's autocrlf on Windows) reads as the same file, not as an edit.
const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (path) => lf(readFileSync(path, "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// How an operator runs this command: `kestrel` is on the PATH only inside an npm script.
const RUN = "npm run check-context --";

/** A context file's header (`version`, `hash`, or null when it has none) and its body. */
function parse(text) {
  const m = HEADER.exec(text);
  if (!m) {
    return { header: null, body: text };
  }
  return {
    header: { version: m[1], hash: m[2] },
    body: text.slice(0, m.index) + text.slice(m.index + m[0].length),
  };
}

/**
 * `body` with a header recording this release and `hash`: the hash of `body` itself, or for a
 * file the operator merged, of the release's file it now includes.
 */
export function stamp(body, hash = sha256(body)) {
  const note = `@kurtbruns/kestrel ${PACKAGE.version}, sha256:${hash}`;
  // A skill's front matter has to open the file, so its header goes inside it.
  if (body.startsWith("---\n")) {
    return `---\n# ${note} (kestrel check-context compares against this line)\n${body.slice(4)}`;
  }
  return `<!-- ${note}. Kestrel check-context compares against this line; your edits are yours. -->\n${body}`;
}

/** Write the release's copy of a context file into the instance at `root`, stamped. */
export function writeShipped(root, file) {
  const to = join(root, file);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, stamp(read(shippedPath(file))));
}

/** Where a context file stands against the installed release. */
function status(root, file) {
  const path = join(root, file);
  const release = read(shippedPath(file));
  if (!existsSync(path)) {
    return { state: "missing" };
  }
  const { header, body } = parse(read(path));
  const releaseHash = sha256(release);
  if (sha256(body) === releaseHash) {
    return { state: "current", header, restamp: header?.hash !== releaseHash };
  }
  if (!header) {
    return { state: "unknown" };
  }
  if (header.hash === releaseHash) {
    return { state: "current", header, edited: true };
  }
  return { state: sha256(body) === header.hash ? "outdated" : "diverged", header };
}

/**
 * The unified diff from the instance's file to the release's, header left out of both, under
 * the labels `yours/` and `release/`; null without git.
 */
function diff(root, file) {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-context-"));
  const name = basename(file);
  for (const [side, text] of [
    ["yours", parse(read(join(root, file))).body],
    ["release", read(shippedPath(file))],
  ]) {
    mkdirSync(join(dir, side));
    writeFileSync(join(dir, side, name), text);
  }
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", `yours/${name}`, `release/${name}`], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return "";
  } catch (err) {
    // `git diff --no-index` exits 1 when the files differ, with the diff on stdout.
    return err.status === 1 ? err.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `kestrel check-context [--update] [--merged <file>]`. */
export function checkContextCommand(argv, root = process.cwd()) {
  const mergedAt = argv.indexOf("--merged");
  if (mergedAt !== -1) {
    const file = relative(root, resolve(root, argv[mergedAt + 1] ?? "")).replaceAll("\\", "/");
    if (!CONTEXT_FILES.includes(file) || !existsSync(join(root, file))) {
      console.error(
        `[check-context] --merged takes one of: ${CONTEXT_FILES.join(", ")} (and it must exist).`,
      );
      process.exit(1);
    }
    // The body stays the operator's; the header now says it has this release's changes.
    const { body } = parse(read(join(root, file)));
    const release = read(shippedPath(file));
    writeFileSync(join(root, file), stamp(body, sha256(release)));
    console.log(`[check-context] ${file}: recorded as merged with ${PACKAGE.version}`);
    return;
  }

  const update = argv.includes("--update");
  let pending = 0;
  for (const file of CONTEXT_FILES) {
    const s = status(root, file);
    const had = s.header ? ` (yours came from ${s.header.version})` : "";
    switch (s.state) {
      case "current":
        if (update && s.restamp) {
          writeShipped(root, file);
        }
        console.log(`[check-context] ${file}: current${s.edited ? ", with your edits" : ""}`);
        break;
      case "missing":
        if (update) {
          writeShipped(root, file);
          console.log(`[check-context] ${file}: restored from ${PACKAGE.version}`);
        } else {
          pending++;
          console.log(
            `[check-context] ${file}: missing; \`${RUN} --update\` writes ${PACKAGE.version}'s`,
          );
        }
        break;
      case "outdated":
        if (update) {
          writeShipped(root, file);
          console.log(`[check-context] ${file}: updated to ${PACKAGE.version}${had}`);
        } else {
          pending++;
          console.log(
            `[check-context] ${file}: Kestrel ${PACKAGE.version} changed it${had}, and you haven't edited it; \`${RUN} --update\` takes the new one`,
          );
        }
        break;
      case "diverged":
      case "unknown": {
        pending++;
        const why =
          s.state === "diverged"
            ? `Kestrel ${PACKAGE.version} changed it${had}, and you've edited it`
            : "it has no Kestrel header, so your edits can't be told from Kestrel's changes";
        console.log(`[check-context] ${file}: ${why}.`);
        const d = diff(root, file);
        console.log(
          d === null
            ? `  Compare it with ${shippedPath(file)}.`
            : `  From yours to ${PACKAGE.version}'s, header aside (lines starting + are the release's):\n${d}`,
        );
        console.log(
          `  Merge what you want of it into yours, then record that: ${RUN} --merged ${file}`,
        );
        break;
      }
    }
  }
  if (pending > 0) {
    console.log(
      "[check-context] The changelog says what changed in Claude's context and why, and marks a change that bears on safety.",
    );
  }
}
