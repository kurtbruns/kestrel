#!/usr/bin/env node
/*
 * Prove the npm package works from an instance repository, the way an operator consumes it.
 *
 * Packs this repository as `npm publish` would (the `prepare` build included), checks the
 * tarball holds what an instance needs and none of Kestrel's source, and packs the client
 * (packages/kestrel, published as the unscoped `kestrel`), checking it holds only its own
 * files. Then it scaffolds a scratch instance with the client's `kestrel init`, which fetches the
 * packed instance package through npx as it fetches the release from npm, and installs the
 * tarball into it, which on
 * npm 12 must block no dependency's install script. In that instance it runs the scaffold's typecheck (`wrangler types` and `tsc`), `tsc` again with
 * Kestrel's declaration checked too, and a `wrangler deploy --dry-run` that bundles the Worker
 * from node_modules; checks that the config's top level, deployed without `--env`, would answer
 * on no address and run no schedule; applies the migrations init copied to a local database;
 * and checks that
 * the client's `kestrel check-context`, handed to that install, finds every context file
 * current. Last it runs the instance: `npm run dev` must answer its health check and serve the
 * editor, `kestrel seed` must load the demo through it, and the client's `kestrel api --local`
 * must read it back. The instance installs the
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
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "packages/kestrel/lib/api.mjs",
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

// The client is its own package with no build: it ships its command and modules, and nothing
// a client run from anywhere has no use for.
const clientPackText = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
  cwd: join(ROOT, "packages", "kestrel"),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const clientPackOutput = JSON.parse(clientPackText.slice(clientPackText.search(/^[[{]$/m)));
const clientPacked = Array.isArray(clientPackOutput)
  ? clientPackOutput[0]
  : Object.values(clientPackOutput)[0];
const clientFiles = clientPacked.files.map((f) => f.path);
const CLIENT_FILES = /^(package\.json|README\.md|LICENSE|bin\/kestrel\.mjs|lib\/[\w-]+\.mjs)$/;
const clientStray = clientFiles.filter((f) => !CLIENT_FILES.test(f));
if (!clientFiles.includes("bin/kestrel.mjs") || clientStray.length > 0) {
  fail(`the client package holds ${clientFiles.join(", ")}`);
}
if (!clientFiles.every((f) => !f.startsWith("lib/") || files.includes(`packages/kestrel/${f}`))) {
  fail("the instance package doesn't ship every module of the client");
}
console.log(
  `[check-package] ${clientPacked.filename}: ${clientFiles.length} files, ${clientPacked.size} bytes`,
);
const client = join(work, "client");
mkdirSync(client);
step("tar", ["-xzf", join(work, clientPacked.filename), "-C", client], work);
const clientBin = join(client, "package", "bin", "kestrel.mjs");

// --- A scratch instance, scaffolded by the client's init -----------------------------------
// `npx kestrel init` runs the client, which finds no instance package installed and fetches
// one through npx; the packed tarball stands in for the release npm doesn't have yet.
const tarball = join(work, packed.filename);
const instance = join(work, "instance");
console.log(`[check-package] $ kestrel init ${instance} (the client, fetching ${packed.filename})`);
const init = spawnSync(process.execPath, [clientBin, "init", instance], {
  cwd: work,
  env: { ...process.env, KESTREL_INSTANCE_PACKAGE: tarball },
  stdio: "inherit",
});
if (init.status !== 0) {
  fail(`the client's kestrel init exited ${init.status}`);
}

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
  ".claude/skills/migrate-list/SKILL.md",
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
// tools install at the versions this repository uses. The install must end cleanly: npm 12
// blocks a dependency's install script that the scaffold's `allowScripts` doesn't cover and
// ends with a warning listing it, which reads like a failure to a new operator. Older npm
// ignores `allowScripts` and runs every script, so it never warns: on older npm (CI's, from
// Node 22) this one install runs through a pinned npm 12 instead, so the check proves what an
// operator on npm 12 sees, and the rest of the run keeps the host's npm. A tarball is a non-registry
// source, so npm 12 would also hold back the package's own `prepare` (its build, which an
// operator's registry install never runs). The scratch instance denies it under the key npm
// gives a tarball, its `file:` path, which an operator's instance has no need to.
const instancePkgPath = join(instance, "package.json");
const instancePkg = JSON.parse(readFileSync(instancePkgPath, "utf8"));
instancePkg.allowScripts = { ...instancePkg.allowScripts, [`file:${tarball}`]: false };
writeFileSync(instancePkgPath, `${JSON.stringify(instancePkg, null, 2)}\n`);
const installArgs = [
  "install",
  "--no-audit",
  "--no-fund",
  tarball,
  `wrangler@${versionOf("wrangler")}`,
  `typescript@${versionOf("typescript")}`,
];
const NPM_12 = "npm@12.0.1";
const hostNpmMajor = Number(execFileSync("npm", ["--version"], { encoding: "utf8" }).split(".")[0]);
const [installCmd, installCmdArgs] =
  hostNpmMajor >= 12 ? ["npm", installArgs] : ["npx", ["-y", NPM_12, ...installArgs]];
console.log(`[check-package] $ ${installCmd} ${installCmdArgs.join(" ")}`);
const install = spawnSync(installCmd, installCmdArgs, { cwd: instance, encoding: "utf8" });
process.stdout.write(install.stdout);
process.stderr.write(install.stderr);
if (install.status !== 0) {
  fail(`npm install exited ${install.status}`);
}
if (/install scripts blocked/.test(`${install.stdout}${install.stderr}`)) {
  fail(
    "the instance's npm install blocked install scripts: add them to template/package.json's allowScripts",
  );
}
// The typecheck is a Deploy step a newcomer runs by hand, so it must also end without wrangler
// asking for anything: "Action required" reads like a failure.
console.log("[check-package] $ npm run typecheck");
const typecheck = spawnSync("npm", ["run", "typecheck"], { cwd: instance, encoding: "utf8" });
process.stdout.write(typecheck.stdout);
process.stderr.write(typecheck.stderr);
if (typecheck.status !== 0) {
  fail(`npm run typecheck exited ${typecheck.status}`);
}
if (/Action required/.test(`${typecheck.stdout}${typecheck.stderr}`)) {
  fail("the instance's typecheck ends with wrangler's \"Action required\"");
}
// What wrangler tests before asking for Node types: the scaffold's @types/node is installed.
if (!existsSync(join(instance, "node_modules", "@types", "node"))) {
  fail("the instance has no node_modules/@types/node: keep it in template/package.json");
}
// Again without skipLibCheck, so Kestrel's own declaration is checked too.
step("npx", ["--no", "--", "tsc", "--skipLibCheck", "false"]);
step("npx", ["--no", "--", "wrangler", "deploy", "--dry-run", "--outdir", "bundle"]);

// A wrangler command without `--env production` takes the top level, which is development (the
// fake transport, the local sign-in), so a deploy of it must stay inert: no address to answer
// on and no schedule to sweep on (SPEC, Trusted, not guarded), while production keeps its
// sweep. The cron list must be present and empty, not just absent: wrangler clears a Worker's
// schedule only when it is given a list, so a missing one leaves an earlier bare deploy's
// cron running. Read as the instance's own wrangler resolves the file, and this repository's too.
const wrangler = await import(
  pathToFileURL(createRequire(instancePkgPath).resolve("wrangler")).href
);
for (const [name, file] of [
  ["template/wrangler.jsonc", join(instance, "wrangler.jsonc")],
  ["wrangler.jsonc", join(ROOT, "wrangler.jsonc")],
]) {
  const top = wrangler.unstable_readConfig({ config: file });
  const live = [
    top.workers_dev !== false && "workers_dev",
    top.preview_urls !== false && "preview_urls",
    (top.route || top.routes?.length) && "a route",
    !(Array.isArray(top.triggers?.crons) && top.triggers.crons.length === 0) &&
      "a cron list that isn't present and empty",
  ].filter(Boolean);
  if (live.length > 0) {
    fail(`${name}'s top level would run if deployed without --env: ${live.join(", ")}`);
  }
}
const production = wrangler.unstable_readConfig({
  config: join(instance, "wrangler.jsonc"),
  env: "production",
});
if (!production.triggers?.crons?.includes("* * * * *")) {
  fail("template/wrangler.jsonc's production env has no once-a-minute cron for the send sweep");
}

// init copied every migration the release ships, and they apply to a local database.
const shipped = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
const synced = readdirSync(join(instance, "migrations"));
if (shipped.some((f) => !synced.includes(f))) {
  fail(`init copied ${synced.join(", ")}, not every one of ${shipped.join(", ")}`);
}
step("npx", ["--no", "--", "wrangler", "d1", "migrations", "apply", "DB", "--local"]);
step("npm", ["run", "sync-migrations"]);

// Each context file's header matches its content: a fresh instance has nothing to update. The
// client runs it, handing it to the instance's install.
const context = spawnSync(process.execPath, [clientBin, "check-context"], {
  cwd: instance,
  encoding: "utf8",
});
const lines = context.stdout.trim().split("\n");
if (context.status !== 0 || lines.some((l) => !/: current$/.test(l))) {
  fail(`check-context on a fresh instance:\n${context.stdout}${context.stderr}`);
}

// The instance runs: `npm run dev` serves the Worker from node_modules (the health check and
// the editor answer), and seed loads the demo through it. A bundle that only fails once it
// runs gets this far and no further. Seed is given no port, so it finds the server through the
// record `kestrel dev` left and the run ID the Worker reports, with a PORT naming somewhere
// else that it must not follow.
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
  ? spawnSync("npx", ["--no", "--", "kestrel", "seed"], {
      cwd: instance,
      env: { ...process.env, PORT: "1" },
      encoding: "utf8",
    })
  : null;
// The client reaches the same server as its stand-in person, through the record `kestrel dev`
// left, and reads back the posts seed made.
const listed =
  seeded?.status === 0
    ? spawnSync(process.execPath, [clientBin, "api", "GET", "/api/posts", "--local"], {
        cwd: instance,
        encoding: "utf8",
      })
    : null;
let posts = null;
try {
  posts = JSON.parse(listed?.stdout ?? "");
} catch {
  /* reported below */
}
stopDev();
if (health?.status !== "ok" || dashboard !== 200 || seeded?.status !== 0) {
  fail(
    `the instance's dev server: health ${JSON.stringify(health)}, /dashboard/ ${dashboard}, seed ${seeded?.status}\n${seeded?.stderr ?? ""}${devLog.slice(-2000)}`,
  );
}
if (listed?.status !== 0 || !posts) {
  fail(
    `the client's kestrel api --local exited ${listed?.status}\n${listed?.stdout}${listed?.stderr}`,
  );
}

console.log(
  "[check-package] ok: the packed client scaffolds an instance from the packed package that typechecks, bundles, migrates, runs, checks its context, and answers the client",
);
if (!keep) {
  rmSync(work, { recursive: true, force: true });
}
