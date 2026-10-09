#!/usr/bin/env node
/*
 * Prove the npm package works from an instance repository, the way an operator consumes it.
 *
 * Packs this repository as `npm publish` would (the `prepare` build included), checks the
 * tarball holds what an instance needs and none of Kestrel's source, then scaffolds a scratch
 * instance with the package's own `kestrel init` and installs the tarball into it. In that
 * instance it runs the scaffold's typecheck (`wrangler types` and `tsc`), `tsc` again with
 * Kestrel's declaration checked too, and a `wrangler deploy --dry-run` that bundles the Worker
 * from node_modules; applies the migrations init copied to a local database; and checks that
 * `kestrel check-context` finds every context file current. Last it runs the instance: `npm
 * run dev` must answer its health check and serve the editor, and `kestrel seed` must load the
 * demo through it. The instance installs the
 * wrangler and TypeScript versions this repository uses, so a failure here is the package's,
 * not a newer tool's.
 *
 * The CI gate runs it after the quality gate. `--keep` leaves the scratch directory in place
 * to look at; it is printed either way.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const versionOf = (name) =>
  JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version;

// Files the tarball must carry, and the prefixes it must not: an instance builds from the
// compiled Worker, never the source.
const REQUIRED = [
  "package.json",
  "dist/worker/index.js",
  "dist/worker/index.d.ts",
  "dist/public/dashboard/index.html",
  "dist/public/dashboard/app.js",
  "bin/kestrel.mjs",
  "cli/dev.mjs",
  "template/wrangler.jsonc",
  "template/claude/CLAUDE.md",
  ".dev.vars.example",
  "demo/publication.md",
  "migrations/0001_init.sql",
  "docs/README.md",
  "CHANGELOG.md",
];
const FORBIDDEN = ["src/", "client/", "shared/", "test/", "scripts/", ".claude/", "public/"];

const work = mkdtempSync(join(tmpdir(), "kestrel-package-"));
console.log(`[check-package] scratch: ${work}`);

/** Run a command in the scratch instance, failing the check when it fails. */
function step(cmd, args, cwd = join(work, "instance")) {
  console.log(`[check-package] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    fail(`${cmd} ${args[0] ?? ""} exited ${r.status}`);
  }
}

/** A port free on loopback right now, for the instance's dev server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function fail(message) {
  console.error(`[check-package] FAILED: ${message} (scratch kept at ${work})`);
  process.exit(1);
}

// --- Pack, and check what the tarball holds -----------------------------------------------
// `npm pack` runs the `prepare` build first, as `npm publish` does, and the build's log lands
// on stdout ahead of the JSON (npm 10 even with --ignore-scripts), so the JSON is read from
// its opening line. npm 10 prints a list of packages, npm 11 and later an object keyed by name.
const packText = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const packOutput = JSON.parse(packText.slice(packText.search(/^[[{]$/m)));
const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0];
const files = packed.files.map((f) => f.path);
const missing = REQUIRED.filter((f) => !files.includes(f));
const leaked = files.filter((f) => FORBIDDEN.some((p) => f.startsWith(p)));
if (missing.length > 0 || leaked.length > 0) {
  fail(
    [
      missing.length ? `missing ${missing.join(", ")}` : "",
      leaked.length ? `ships source ${leaked.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
}
console.log(`[check-package] ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

// --- A scratch instance, scaffolded by the package's own init ------------------------------
// init runs from the tarball unpacked beside the instance, as `npx @kurtbruns/kestrel init`
// runs it from npm's cache.
const unpacked = join(work, "unpacked");
mkdirSync(unpacked);
step("tar", ["-xzf", join(work, packed.filename), "-C", unpacked], work);
const instance = join(work, "instance");
step(process.execPath, [join(unpacked, "package", "bin", "kestrel.mjs"), "init", instance], work);

// init wrote every file an instance starts with, under its instance name, and nothing under a
// shipped name.
const INSTANCE_FILES = [
  "package.json",
  ".npmrc",
  ".gitignore",
  ".dev.vars.example",
  "wrangler.jsonc",
  "tsconfig.json",
  "src/index.ts",
  ".claude/CLAUDE.md",
  ".claude/skills/upgrade/SKILL.md",
];
const absent = INSTANCE_FILES.filter((f) => !existsSync(join(instance, f)));
const stray = ["claude", "gitignore", "npmrc"].filter((f) => existsSync(join(instance, f)));
if (absent.length > 0 || stray.length > 0) {
  fail(
    `init wrote ${stray.length ? `${stray.join(", ")} under shipped names` : ""}${absent.length ? ` and no ${absent.join(", ")}` : ""}`,
  );
}

// The scaffold's config tracks this repository's: the same runtime date and flags.
const setting = (file, key) =>
  readFileSync(file, "utf8").match(new RegExp(`"${key}":\\s*("[^"]+"|\\[[^\\]]*\\])`))?.[1];
for (const key of ["compatibility_date", "compatibility_flags"]) {
  const ours = setting(join(ROOT, "wrangler.jsonc"), key);
  const theirs = setting(join(instance, "wrangler.jsonc"), key);
  if (ours !== theirs) {
    fail(`template/wrangler.jsonc has ${key} ${theirs}, wrangler.jsonc has ${ours}`);
  }
}

// The instance pins a release npm doesn't have yet, so the tarball stands in for it, and the
// tools install at the versions this repository uses.
step("npm", [
  "install",
  "--no-audit",
  "--no-fund",
  join(work, packed.filename),
  `wrangler@${versionOf("wrangler")}`,
  `typescript@${versionOf("typescript")}`,
]);
step("npm", ["run", "typecheck"]);
// Again without skipLibCheck, so Kestrel's own declaration is checked too.
step("npx", ["--no", "--", "tsc", "--skipLibCheck", "false"]);
step("npx", ["--no", "--", "wrangler", "deploy", "--dry-run", "--outdir", "bundle"]);

// init copied every migration the release ships, and they apply to a local database.
const shipped = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
const synced = readdirSync(join(instance, "migrations"));
if (shipped.some((f) => !synced.includes(f))) {
  fail(`init copied ${synced.join(", ")}, not every one of ${shipped.join(", ")}`);
}
step("npx", ["--no", "--", "wrangler", "d1", "migrations", "apply", "DB", "--local"]);
step("npm", ["run", "sync-migrations"]);

// Each context file's header matches its content: a fresh instance has nothing to update.
const context = spawnSync("npx", ["--no", "--", "kestrel", "check-context"], {
  cwd: instance,
  encoding: "utf8",
});
const lines = context.stdout.trim().split("\n");
if (context.status !== 0 || lines.some((l) => !/: current$/.test(l))) {
  fail(`check-context on a fresh instance:\n${context.stdout}${context.stderr}`);
}

// The instance runs: `npm run dev` serves the Worker from node_modules (the health check and
// the editor answer), and seed loads the demo through it. A bundle that only fails once it
// runs gets this far and no further.
copyFileSync(join(instance, ".dev.vars.example"), join(instance, ".dev.vars"));
const port = String(await freePort());
const dev = spawn("npm", ["run", "dev"], {
  cwd: instance,
  env: { ...process.env, PORT: port },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let devLog = "";
dev.stdout.on("data", (d) => {
  devLog += d;
});
dev.stderr.on("data", (d) => {
  devLog += d;
});
const stopDev = () => {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
};
const base = `http://localhost:${port}`;
let health = null;
for (let i = 0; i < 90 && !health; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  health = await fetch(`${base}/health`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
const dashboard = health ? (await fetch(`${base}/dashboard/`).catch(() => null))?.status : null;
const seeded = health
  ? spawnSync("npx", ["--no", "--", "kestrel", "seed", port], { cwd: instance, encoding: "utf8" })
  : null;
stopDev();
if (health?.status !== "ok" || dashboard !== 200 || seeded?.status !== 0) {
  fail(
    `the instance's dev server: health ${JSON.stringify(health)}, /dashboard/ ${dashboard}, seed ${seeded?.status}\n${seeded?.stderr ?? ""}${devLog.slice(-2000)}`,
  );
}

console.log(
  "[check-package] ok: the packed package scaffolds an instance that typechecks, bundles, migrates, runs, and checks its context",
);
if (!keep) {
  rmSync(work, { recursive: true, force: true });
}
