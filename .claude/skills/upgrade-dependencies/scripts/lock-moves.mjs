// Compares package-lock.json with a git ref package by package, for the upgrade-dependencies
// skill, since reordering and deduping can bury the real moves in the raw diff. It reads the
// working tree's lockfile, and the ref defaults to where this branch left origin/main, so a
// committed upgrade still shows. Exits 1 on a finding that needs a look. Changes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// CI runs on Linux x64 with glibc. Binaries arrive as optional dependencies, which a lockfile
// written on another platform can lose. Names end in linux-x64, linux-x64-gnu, or (workerd)
// linux-64; musl builds aren't what CI loads.
const CI_BINARY = /linux-(x64|64)(-gnu)?$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1e8 });
}

const ref = process.argv[2] ?? git("merge-base", "origin/main", "HEAD").trim();
const baseText = git("show", `${ref}:package-lock.json`);
const nextText = readFileSync("package-lock.json", "utf8");
if (baseText === nextText) {
  console.error(`package-lock.json is identical to ${ref}, so there is nothing to compare.`);
  console.error("Name a ref from before the upgrade: lock-moves.mjs <ref>");
  process.exit(1);
}
const base = JSON.parse(baseText).packages;
const next = JSON.parse(nextText).packages;

function packageName(path, entry) {
  return entry.name ?? path.split("node_modules/").pop();
}

/**
 * Whether a link or bundled entry really holds no download of its own. The flag alone can't
 * decide, since npm still fetches a flagged entry that has an address, so it has to agree with
 * the rest of the lockfile: a link's target has an entry, and a bundled package sits under one
 * that declares bundling.
 */
function holdsNoDownload(packages, path, entry) {
  if (entry.link) {
    return Boolean(packages[entry.resolved]);
  }
  if (!entry.inBundle) {
    return false;
  }
  for (let cut = path.lastIndexOf("/node_modules/"); cut !== -1; ) {
    const bundled = packages[path.slice(0, cut)]?.bundleDependencies;
    if (bundled === true || bundled?.length) {
      return true;
    }
    cut = path.lastIndexOf("/node_modules/", cut - 1);
  }
  return false;
}

function downloaded(packages) {
  return Object.entries(packages).filter(
    ([path, entry]) => path && !holdsNoDownload(packages, path, entry),
  );
}

function signature(entry) {
  return `${entry.integrity} ${entry.resolved}`;
}

/** Each package's name mapped to its sorted versions, every copy's download by name@version, and the names running install scripts. */
function index(packages) {
  const versions = new Map();
  const downloads = new Map();
  const scripts = new Set();
  const platform = new Set();
  for (const [path, entry] of downloaded(packages)) {
    const name = packageName(path, entry);
    const id = `${name}@${entry.version}`;
    versions.set(name, [...(versions.get(name) ?? []), entry.version].sort());
    downloads.set(id, (downloads.get(id) ?? new Set()).add(signature(entry)));
    if (entry.hasInstallScript) {
      scripts.add(name);
    }
    if (entry.os || entry.cpu) {
      platform.add(name);
    }
  }
  return { versions, downloads, scripts, platform };
}

const before = index(base);
const after = index(next);

// Every platform binary some package asks for at that exact version.
const askedFor = new Set();
for (const [, entry] of downloaded(next)) {
  for (const [dependency, wanted] of Object.entries(entry.optionalDependencies ?? {})) {
    askedFor.add(`${dependency}@${wanted}`);
  }
}

let platformMoves = 0;
console.log(`comparing with ${ref}`);
console.log(`entries: ${Object.keys(base).length} -> ${Object.keys(next).length}`);
for (const name of [...new Set([...before.versions.keys(), ...after.versions.keys()])].sort()) {
  const from = before.versions.get(name);
  const to = after.versions.get(name);
  if (from?.join() === to?.join()) {
    continue;
  }
  // A platform binary moving to exactly what its parent asks for is only worth a count. Anything
  // else is listed: one that appears or disappears, or moves where no parent sent it.
  const followsParent = to?.every((version) => askedFor.has(`${name}@${version}`));
  if (from && followsParent && before.platform.has(name) && after.platform.has(name)) {
    platformMoves++;
  } else {
    console.log(`${name}: ${from?.join(", ") ?? "(none)"} -> ${to?.join(", ") ?? "(none)"}`);
  }
}
console.log(`platform binaries moved: ${platformMoves}`);

const findings = [];

for (const [path, entry] of downloaded(next)) {
  const name = packageName(path, entry);
  const file = `${name.split("/").pop()}-${entry.version}.tgz`;
  const expected = `https://registry.npmjs.org/${name}/-/${file}`;
  if (!entry.integrity) {
    findings.push(`${path} has no integrity hash`);
  }
  if (entry.resolved !== expected) {
    findings.push(`${path} resolves to ${entry.resolved}, not ${expected}`);
  }
}

// The same name and version must download the same bytes from the same place, in every copy.
for (const [path, entry] of downloaded(next)) {
  const id = `${packageName(path, entry)}@${entry.version}`;
  const was = before.downloads.get(id);
  if (was && !was.has(signature(entry))) {
    findings.push(`${path} (${id}) changed its hash or address without changing its version`);
  }
}

for (const name of after.scripts) {
  if (!before.scripts.has(name)) {
    findings.push(`${name} newly runs an install script`);
  }
}

/** The entry Node would load for a dependency of the package at `from`: the nearest one up the tree. */
function resolveFrom(from, dependency) {
  let dir = from;
  for (;;) {
    const found = next[`${dir ? `${dir}/` : ""}node_modules/${dependency}`];
    if (found) {
      return found;
    }
    if (!dir) {
      return undefined;
    }
    const parent = dir.lastIndexOf("/node_modules/");
    dir = parent === -1 ? "" : dir.slice(0, parent);
  }
}

for (const [path, entry] of downloaded(next)) {
  const runsOnCI = !entry.os || entry.os.includes("linux");
  for (const [dependency, wanted] of Object.entries(entry.optionalDependencies ?? {})) {
    const found = resolveFrom(path, dependency);
    const owner = `${packageName(path, entry)}@${entry.version}`;
    if (!found) {
      // A lockfile may leave out another platform's optional package, but not one CI loads.
      if (runsOnCI && CI_BINARY.test(dependency)) {
        findings.push(`${dependency}, which CI needs for ${owner}, is missing`);
      }
    } else if (/^\d/.test(wanted) && found.version !== wanted) {
      findings.push(`${owner} asks for ${dependency} ${wanted}, and finds ${found.version}`);
    }
  }
}

console.log(findings.length ? `\nLook at:\n- ${findings.join("\n- ")}` : "\nNothing to look at.");
process.exitCode = findings.length ? 1 : 0;
