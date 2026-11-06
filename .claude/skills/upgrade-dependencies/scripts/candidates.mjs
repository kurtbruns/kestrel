// Lists each outdated package with the newest version that has aged the cooldown, for the
// upgrade-dependencies skill. Reads the registry and changes nothing. Exits 1 when it couldn't
// answer for every package, so a partial list never reads as a complete one.
import { execFileSync } from "node:child_process";

// Three days matches Dependabot's default cooldown: long enough that a compromised release is
// usually caught and pulled, short enough not to leave a fix waiting.
const COOLDOWN_DAYS = 3;
const DAY_MS = 86_400_000;

function compareVersions(a, b) {
  const [aCore, aPre] = a.split("+")[0].split("-");
  const [bCore, bPre] = b.split("+")[0].split("-");
  const x = aCore.split(".").map(Number);
  const y = bCore.split(".").map(Number);
  const byCore = x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  if (byCore) {
    return byCore;
  }
  // A prerelease comes before its release.
  if (aPre && bPre) {
    return aPre.localeCompare(bPre, undefined, { numeric: true });
  }
  return aPre ? -1 : bPre ? 1 : 0;
}

/** The part of a version a breaking change moves: the major, or under 1.0 the minor too. */
function breakingLine(version) {
  const [major, minor] = version.split(".");
  return major === "0" ? `0.${minor}` : major;
}

function readOutdated() {
  try {
    return execFileSync("npm", ["outdated", "--json"], { encoding: "utf8" });
  } catch (error) {
    // npm outdated exits 1 whenever anything is behind, with the answer still on stdout.
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      return error.stdout;
    }
    throw error;
  }
}

function describe(meta, version, now) {
  const days = ((now - new Date(meta.time[version])) / DAY_MS).toFixed(1);
  const scripts = meta.versions[version].scripts ?? {};
  const install = ["preinstall", "install", "postinstall"].filter((name) => scripts[name]);
  return `${version} (${days}d${install.length ? `, runs ${install.join(", ")}` : ""})`;
}

async function readRegistry(name) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
    if (response.ok) {
      return await response.json();
    }
    console.log(`${name}: the registry answered ${response.status}`);
  } catch (error) {
    console.log(`${name}: the registry couldn't be read (${error.message})`);
  }
  return null;
}

const outdated = JSON.parse(readOutdated() || "{}");
if (outdated.error?.code) {
  console.error(`npm outdated failed: ${outdated.error.summary ?? outdated.error.code}`);
  process.exit(1);
}
if (Object.keys(outdated).length === 0) {
  console.log("Nothing outdated.");
}

const now = Date.now();
let failed = 0;
for (const [name, entry] of Object.entries(outdated)) {
  // A package installed in more than one place reports an array; the first says enough here.
  const { current } = Array.isArray(entry) ? entry[0] : entry;
  if (!current) {
    console.error(`${name} isn't installed, so it can't be compared. Run \`npm ci\` first.`);
    process.exit(1);
  }
  const meta = await readRegistry(name);
  if (!meta) {
    failed++;
    continue;
  }
  const stable = Object.keys(meta.versions)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => !meta.versions[version].deprecated)
    .filter((version) => compareVersions(version, current) > 0)
    .sort(compareVersions);
  const line = breakingLine(current);
  const sameLine = stable.filter((version) => breakingLine(version) === line);
  const aged = sameLine.filter((v) => now - new Date(meta.time[v]) >= COOLDOWN_DAYS * DAY_MS);
  const newestAged = aged.at(-1);
  const newest = sameLine.at(-1);
  const newerMajor = stable.filter((version) => breakingLine(version) !== line).at(-1);

  console.log(`${name} ${current}`);
  if (meta.versions[current]?.deprecated) {
    console.log(`  deprecated: ${meta.versions[current].deprecated}`);
  }
  if (newestAged) {
    console.log(`  take: ${describe(meta, newestAged, now)}`);
  } else if (!newest) {
    console.log("  take: nothing newer in this major");
  }
  if (newest && newest !== newestAged) {
    console.log(`  cooling down: ${describe(meta, newest, now)}`);
  }
  if (newerMajor) {
    console.log(`  newer major: ${describe(meta, newerMajor, now)}`);
  }
}

if (failed) {
  console.error(`\nIncomplete: ${failed} package(s) couldn't be looked up.`);
  process.exitCode = 1;
}
