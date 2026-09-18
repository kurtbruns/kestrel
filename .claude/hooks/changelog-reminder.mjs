#!/usr/bin/env node
/*
 * Stop hook: remind, don't gate.
 *
 * Kestrel keeps its CHANGELOG.md current as part of the workflow (see
 * .claude/rules/changelog.md). This hook is the reliability net for that: at the end of
 * a turn it looks at what the branch changed and, if code shipped without a CHANGELOG.md
 * entry, surfaces a one-line reminder to add one. It is a NON-BLOCKING nudge — it never
 * exits non-zero and never blocks the stop, so it can't halt a turn or reject a change.
 * The maintainer/agent judges whether the change is actually user-facing.
 *
 * "Code" is src/, public/dashboard/ (the admin UI, which sits outside src/), and
 * migrations/ (schema). Tests and build tooling live outside those prefixes, so a
 * test- or script-only turn stays quiet. Once an entry exists, CHANGELOG.md is itself
 * in the diff and the hook goes silent.
 *
 * Fails safe: any git error, a detached HEAD, or a missing CHANGELOG.md all end in a
 * silent exit 0. Reminds at most once per session (a marker in the temp dir keyed on the
 * session id), so a long session isn't nagged every turn. Pure Node, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Prefixes whose change means "consider a changelog entry". Kept in sync with
// .claude/rules/changelog.md. Tests (test/) and tooling (scripts/) are deliberately absent.
const CODE_PREFIXES = ["src/", "public/dashboard/", "migrations/"];

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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
    // at column 3; take the destination for a rename.
    const path = line.slice(3);
    files.push(path.includes(" -> ") ? path.split(" -> ")[1] : path);
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
  return CODE_PREFIXES.some((p) => path.startsWith(p));
}

/** Read the session id from the hook's stdin JSON, for the once-per-session marker. */
function sessionId() {
  try {
    const raw = readFileSync(0, "utf8");
    return JSON.parse(raw).session_id ?? null;
  } catch {
    return null;
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
  const id = sessionId();

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
      "CHANGELOG reminder: this branch changes code (src/, public/dashboard/, or migrations/) " +
      "but CHANGELOG.md is untouched. If the change is user-facing or operator-visible, add a line " +
      "under [Unreleased] (see .claude/rules/changelog.md). Internal-only changes need no entry.";
    // Synchronous write to fd 1: a plain process.stdout.write() can be dropped when
    // process.exit() follows before the async pipe flush, silently losing the reminder.
    writeSync(1, `${JSON.stringify({ systemMessage: message })}\n`);
  }
} catch {
  // Never let a reminder break a session.
}
process.exit(0);
