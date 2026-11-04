// Compares package-lock.json with a git ref package by package, for the upgrade-dependencies
// skill, since reordering and deduping can bury the real moves in the raw diff. Exits 1 on a
// finding that needs a look. Changes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Biome's and workerd's binaries and esbuild's come as optional per-platform packages, which a
// lockfile written on one platform can lose, and CI runs on Linux.
const CI_BINARIES = [
  "@biomejs/cli-linux-x64",
  "@cloudflare/workerd-linux-64",
  "@esbuild/linux-x64",
];
// Each platform's binary moves with its parent, so listing them hides the moves that matter.
const PLATFORM_PACKAGE =
  /^(@esbuild\/|@biomejs\/cli-|@cloudflare\/workerd-|@rolldown\/binding-|@oxc-|@img\/sharp-|@emnapi\/)/;

const ref = process.argv[2] ?? "HEAD";
const base = JSON.parse(
  execFileSync("git", ["show", `${ref}:package-lock.json`], {
    encoding: "utf8",
    maxBuffer: 1e8,
  }),
);
const next = JSON.parse(readFileSync("package-lock.json", "utf8"));

/** Each package's name mapped to its sorted versions, and the name@versions running install scripts. */
function index(lock) {
  const versions = new Map();
  const scripts = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.link) {
      continue;
    }
    const name = entry.name ?? path.split("node_modules/").pop();
    versions.set(name, [...(versions.get(name) ?? []), entry.version].sort());
    if (entry.hasInstallScript) {
      scripts.add(name);
    }
  }
  return { versions, scripts };
}

const before = index(base);
const after = index(next);
let platformMoves = 0;
console.log(
  `entries: ${Object.keys(base.packages).length} -> ${Object.keys(next.packages).length}`,
);
for (const name of [...new Set([...before.versions.keys(), ...after.versions.keys()])].sort()) {
  const from = (before.versions.get(name) ?? ["(none)"]).join(", ");
  const to = (after.versions.get(name) ?? ["(none)"]).join(", ");
  if (from === to) {
    continue;
  }
  if (PLATFORM_PACKAGE.test(name)) {
    platformMoves++;
  } else {
    console.log(`${name}: ${from} -> ${to}`);
  }
}
console.log(`platform binaries moved: ${platformMoves}`);

const findings = [];
for (const [path, entry] of Object.entries(next.packages)) {
  if (!path || entry.link) {
    continue;
  }
  if (!entry.integrity) {
    findings.push(`${path} has no integrity hash`);
  }
  if (!entry.resolved?.startsWith("https://registry.npmjs.org/")) {
    findings.push(`${path} resolves to ${entry.resolved}`);
  }
}
for (const name of after.scripts) {
  if (!before.scripts.has(name)) {
    findings.push(`${name} newly runs an install script`);
  }
}
for (const name of CI_BINARIES) {
  if (!after.versions.has(name)) {
    findings.push(`${name}, which CI needs, is missing`);
  }
}

console.log(findings.length ? `\nLook at:\n- ${findings.join("\n- ")}` : "\nNothing to look at.");
process.exitCode = findings.length ? 1 : 0;
