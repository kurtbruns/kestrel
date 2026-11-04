// Lists each outdated package with the newest version that has aged the cooldown, for the
// upgrade-dependencies skill. Reads the registry and changes nothing.
import { execFileSync } from "node:child_process";

// Three days matches Dependabot's default cooldown: long enough that a compromised release is
// usually caught and pulled, short enough not to leave a fix waiting.
const COOLDOWN_DAYS = 3;
const DAY_MS = 86_400_000;

function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
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

const outdated = JSON.parse(readOutdated() || "{}");
const now = Date.now();
for (const [name, entry] of Object.entries(outdated)) {
  // A package installed in more than one place reports an array; the first says enough here.
  const current = (Array.isArray(entry) ? entry[0] : entry).current;
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (!response.ok) {
    console.log(`${name}: the registry answered ${response.status}`);
    continue;
  }
  const meta = await response.json();
  const stable = Object.keys(meta.versions)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => compareVersions(version, current) > 0)
    .sort(compareVersions);
  const major = breakingLine(current);
  const sameMajor = stable.filter((version) => breakingLine(version) === major);
  const aged = sameMajor.filter((v) => now - new Date(meta.time[v]) >= COOLDOWN_DAYS * DAY_MS);
  const newestAged = aged.at(-1);
  const newest = sameMajor.at(-1);
  const newerMajor = stable.filter((version) => breakingLine(version) !== major).at(-1);

  console.log(`${name} ${current}`);
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
