#!/usr/bin/env node
/*
 * Resolve the build stamp and write it into the Worker as a generated module.
 *
 * Every instance should be able to say exactly which build it is (SPEC §9). This
 * resolves five facts at build time and writes them to src/generated/version.ts, which
 * the Worker imports (via src/build.ts) and reflects read-only in the reference room and
 * at GET /api/version:
 *
 *   version   — package.json `version`
 *   sha       — `git rev-parse --short HEAD`, falling back to the GIT_SHA env, then "dev"
 *   tag       — the tag on HEAD itself (`git describe --tags --exact-match`), or "". Only
 *               a build that IS a release gets one, so the version can link to its release
 *               page without ever pointing at a tag that doesn't exist yet or a release
 *               the build has moved past.
 *   buildTime — ISO 8601 timestamp of this build
 *   repoUrl   — package.json `repository`, normalized to a browsable https URL
 *
 * A generated module (not wrangler `define`) so the same stamp works uniformly under
 * `wrangler dev`, `wrangler deploy`, and the Vitest pool, and git runs here at build —
 * never in the client. The output is gitignored and regenerated at every entry point so it
 * is always present and current without being committed: `postinstall` (fresh checkout),
 * dev startup (scripts/dev.mjs), the `predeploy` hook (before `wrangler deploy`), and
 * `pretest` / `typecheck`. Deliberately NOT wired as a wrangler `build.command`: wrangler
 * dev watches src/, and this file's build time changes every run, so a build command would
 * rebuild-loop forever. This is build metadata, not deploy config or a runtime preference,
 * so it never touches getConfig/settings (SPEC §9).
 *
 * `--if-changed` (pretest, typecheck): leave the file alone when it already names this
 * version and sha. Those two run beside a live `wrangler dev`, which watches src/ — a fresh
 * build time on every test run would reload the dev server each time for nothing. The
 * entry points that ARE a build (postinstall, dev startup, predeploy) always write, so a
 * deployed build time is that deploy's.
 *
 * Pure Node, no dependencies — runs anywhere `npm ci` does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "generated", "version.ts");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Run git and return trimmed stdout, or null when it fails (no git, no repo, no match). */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Short commit SHA, or a CI-provided / "dev" fallback when git isn't available. */
function resolveSha() {
  return git(["rev-parse", "--short", "HEAD"]) ?? (process.env.GIT_SHA?.trim() || "dev");
}

/** The tag sitting exactly on HEAD, or "" — a commit past the tag is not that release. */
function resolveTag() {
  return git(["describe", "--tags", "--exact-match", "HEAD"]) ?? "";
}

/** Normalize package.json `repository` to a browsable https URL, or "" when absent. */
function resolveRepoUrl() {
  const raw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
  return raw
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .trim();
}

const info = {
  version: String(pkg.version ?? "0.0.0"),
  sha: resolveSha(),
  tag: resolveTag(),
  buildTime: new Date().toISOString(),
  repoUrl: resolveRepoUrl(),
};

/** True when the file on disk already carries this version, sha and tag (`--if-changed`). */
function isCurrent() {
  if (!existsSync(OUT)) {
    return false;
  }
  const cur = readFileSync(OUT, "utf8");
  const same = (k) =>
    cur.match(new RegExp(`^  ${k}: (".*"),$`, "m"))?.[1] === JSON.stringify(info[k]);
  return same("version") && same("sha") && same("tag");
}

if (process.argv.includes("--if-changed") && isCurrent()) {
  console.log(`[version] current  v${info.version}  ${info.sha}  (kept)`);
  process.exit(0);
}

// Emitted WITHOUT `as const`: the string values must widen to `string`, or a literal
// like sha "dev" would make src/build.ts's `sha !== "dev"` a no-overlap type error.
const body = `// GENERATED FILE — do not edit. Written by scripts/stamp-version.mjs at build.
// The build stamp (SPEC §9): version, commit, build time, repo URL. Consumed via
// src/build.ts. Gitignored and regenerated at every build; never deploy config.

export const BUILD_INFO: {
  version: string;
  sha: string;
  tag: string;
  buildTime: string;
  repoUrl: string;
} = {
  version: ${JSON.stringify(info.version)},
  sha: ${JSON.stringify(info.sha)},
  tag: ${JSON.stringify(info.tag)},
  buildTime: ${JSON.stringify(info.buildTime)},
  repoUrl: ${JSON.stringify(info.repoUrl)},
};
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body);
console.log(
  `[version] stamped  v${info.version}  ${info.sha}${info.tag ? `  (${info.tag})` : ""}  ${info.buildTime}`,
);
