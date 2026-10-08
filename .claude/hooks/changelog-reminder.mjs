#!/usr/bin/env node
/*
 * Stop hook: remind, don't gate.
 *
 * Kestrel keeps its CHANGELOG.md current as part of the workflow (see
 * .claude/maintainer/frame.md). This hook is the reliability net for that: at the end of
 * a turn it looks at what the branch changed and, if code shipped without a CHANGELOG.md
 * entry, surfaces a one-line reminder to add one. A Stop hook's `systemMessage` is shown
 * to the person in the transcript, not fed back to the model (only a blocking decision
 * would be, and this never blocks), so the reminder reaches the maintainer, who relays it
 * or acts on it. It is a NON-BLOCKING nudge — it never exits non-zero and never blocks the
 * stop, so it can't halt a turn or reject a change. Whoever reads it judges whether the
 * change is actually user-facing.
 *
 * "Code" is src/, client/ and public/dashboard/ (the admin UI, which sits outside src/),
 * shared/ (code both runtimes ship), and migrations/ (schema). Tests and build tooling
 * live outside those prefixes, and specs kept beside the code (`*.spec.ts`) are skipped,
 * so a test- or script-only turn stays quiet. Once an entry exists, CHANGELOG.md is itself
 * in the diff and the hook goes silent.
 *
 * Maintainers only. This file is committed, so it runs in every copy of the repository,
 * including an operator's, whose own changes to their copy owe Kestrel's changelog nothing.
 * It stays silent unless a CLAUDE.local.md imports the maintainer frame
 * (.claude/maintainer/README.md); the import line, not the file, is the switch, since anyone
 * may keep notes of their own in a CLAUDE.local.md. Claude Code loads CLAUDE.local.md from
 * the session's directory and every one above it, so a worktree inside the maintainer's
 * checkout has the frame through the root's file, and the check walks up the same way. The
 * diff is the checkout the session works in, found from the hook input's `cwd`: in a
 * worktree CLAUDE_PROJECT_DIR names the main checkout, whose diff is not this branch's.
 *
 * Fails safe: any git error, a detached HEAD, or a missing CHANGELOG.md all end in a
 * silent exit 0. Reminds at most once per session (a marker in the temp dir keyed on the
 * session id), so a long session isn't nagged every turn. Pure Node, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Prefixes whose change means "consider a changelog entry", named again in the reminder's
// message below. Tests (test/) and tooling (scripts/) are deliberately absent.
const CODE_PREFIXES = ["src/", "client/", "shared/", "public/dashboard/", "migrations/"];

// The line in CLAUDE.local.md that turns the maintainer frame on.
const FRAME_IMPORT = /^@\.claude\/maintainer\/frame\.md\s*$/m;

/** The hook's stdin JSON (session_id, cwd), or {} when it can't be read. */
function hookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = hookInput();
let projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Run git in the project dir; return stdout with only the trailing newline removed, or
 * null on any failure. NB: strip trailing newline, not `.trim()` — `git status
 * --porcelain` encodes the status in the first two columns, so the leading space of an
 * unstaged line (` M path`) is significant and must survive.
 */
function git(args) {
  try {
    const out = execFileSync("git", args, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.replace(/\n+$/, "");
  } catch {
    return null;
  }
}

/** Files changed in the working tree, staged or not, plus untracked. */
function workingTreeFiles() {
  const out = git(["status", "--porcelain"]);
  if (out == null) {
    return null; // not a git repo (or git unavailable) — signal "bail"
  }
  const files = [];
  for (const line of out.split("\n")) {
    if (!line) {
      continue;
    }
    // Porcelain v1: "XY <path>" (or "XY <old> -> <new>" for renames). The path starts
    // at column 3; take the destination for a rename. Git wraps a path with a space or a
    // non-ASCII byte in double quotes; strip them so such a path still matches a prefix.
    const path = line.slice(3);
    const dest = path.includes(" -> ") ? path.split(" -> ")[1] : path;
    files.push(dest.replace(/^"(.*)"$/, "$1"));
  }
  return files;
}

/** Files changed on this branch since it diverged from the default branch. */
function committedFiles() {
  for (const base of [git(["rev-parse", "--abbrev-ref", "origin/HEAD"]), "origin/main", "main"]) {
    if (!base) {
      continue;
    }
    const out = git(["diff", "--name-only", `${base}...HEAD`]);
    if (out != null) {
      return out ? out.split("\n").filter(Boolean) : [];
    }
  }
  return []; // no usable base (branch is the default, or fresh) — working tree covers it
}

function isCode(path) {
  // client/ and shared/ keep their specs beside the code; a spec is a test, not a change.
  return CODE_PREFIXES.some((p) => path.startsWith(p)) && !path.endsWith(".spec.ts");
}

/** True when a CLAUDE.local.md in the session's directory, or one above it, imports the maintainer frame. */
function frameOn() {
  for (let dir = input.cwd || projectDir; ; dir = dirname(dir)) {
    try {
      if (FRAME_IMPORT.test(readFileSync(join(dir, "CLAUDE.local.md"), "utf8"))) {
        return true;
      }
    } catch {
      // no CLAUDE.local.md at this level — keep walking up
    }
    if (dirname(dir) === dir) {
      return false;
    }
  }
}

/** True if we've already reminded this session (and records that we have now). */
function alreadyReminded(id) {
  if (!id) {
    return false; // no id — remind (rare; stdin unavailable)
  }
  try {
    const dir = join(tmpdir(), "kestrel-changelog-hook");
    const marker = join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.seen`);
    if (existsSync(marker)) {
      return true;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, "");
    return false;
  } catch {
    return false;
  }
}

try {
  const id = input.session_id ?? null;

  if (!frameOn()) {
    process.exit(0); // not a maintainer session — stay quiet
  }

  // The session may sit in a subdirectory; the checkout's root holds CHANGELOG.md.
  const root = git(["rev-parse", "--show-toplevel"]);
  if (root) {
    projectDir = root;
  }

  if (!existsSync(join(projectDir, "CHANGELOG.md"))) {
    process.exit(0); // no changelog to update — stay quiet
  }

  const working = workingTreeFiles();
  if (working == null) {
    process.exit(0); // not a git repo / git unavailable
  }
  const changed = new Set([...working, ...committedFiles()]);

  const codeTouched = [...changed].some(isCode);
  const changelogTouched = changed.has("CHANGELOG.md");

  if (codeTouched && !changelogTouched && !alreadyReminded(id)) {
    const message =
      "CHANGELOG reminder: this branch changes code (src/, client/, shared/, public/dashboard/, or migrations/) " +
      "but CHANGELOG.md is untouched. If the change is user-facing or operator-visible, add a line " +
      "under [Unreleased] (see .claude/maintainer/frame.md). Internal-only changes need no entry.";
    // Synchronous write to fd 1: a plain process.stdout.write() can be dropped when
    // process.exit() follows before the async pipe flush, silently losing the reminder.
    writeSync(1, `${JSON.stringify({ systemMessage: message })}\n`);
  }
} catch {
  // Never let a reminder break a session.
}
process.exit(0);
