#!/usr/bin/env node
/*
 * Prove the npm package works from an instance repository, the way an operator consumes it.
 *
 * Packs this repository as `npm publish` would (the `prepare` build included), checks the
 * tarball holds what an instance needs and none of Kestrel's source, then installs it into a
 * scratch instance holding only a package.json, the one-line `src/index.ts`, a wrangler config whose assets
 * point into node_modules, and a strict tsconfig. In that instance it runs `wrangler types`,
 * `tsc` (Kestrel's declaration included, with no skipLibCheck), and a `wrangler deploy
 * --dry-run` that bundles the Worker from node_modules. The instance installs the wrangler and
 * TypeScript versions this repository uses, so a failure here is the package's, not a newer
 * tool's.
 *
 * The CI gate runs it after the quality gate. `--keep` leaves the scratch directory in place
 * to look at; it is printed either way.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
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

// --- A scratch instance ---------------------------------------------------------------------
const instance = join(work, "instance");
mkdirSync(join(instance, "src"), { recursive: true });
mkdirSync(join(instance, "migrations"));
const compatibilityDate = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").match(
  /"compatibility_date":\s*"([^"]+)"/,
)?.[1];
const write = (path, value) =>
  writeFileSync(
    join(instance, path),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );

write("package.json", { name: "kestrel-instance-check", private: true, type: "module" });
write("src/index.ts", `export { default } from "${pkg.name}";\n`);
write("wrangler.jsonc", {
  name: "kestrel-instance-check",
  main: "src/index.ts",
  compatibility_date: compatibilityDate,
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: ["* * * * *"] },
  assets: { directory: `./node_modules/${pkg.name}/dist/public`, not_found_handling: "none" },
  d1_databases: [
    {
      binding: "DB",
      database_name: "kestrel-dev",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "migrations",
    },
  ],
  r2_buckets: [{ binding: "MEDIA", bucket_name: "kestrel-media-dev" }],
  vars: {
    PROVIDER: "fake",
    APP_ORIGIN: "http://localhost:8787",
    ARCHIVE_BASE_PATH: "/archive",
    SENDING_DOMAIN: "send.example.com",
    FROM_ADDRESS: "Newsletter <newsletter@send.example.com>",
  },
});
write("tsconfig.json", {
  compilerOptions: {
    target: "es2022",
    module: "es2022",
    moduleResolution: "bundler",
    lib: ["es2022"],
    types: [],
    strict: true,
    noEmit: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
  },
  include: ["src", "worker-configuration.d.ts"],
});

step("npm", [
  "install",
  "--no-audit",
  "--no-fund",
  join(work, packed.filename),
  `wrangler@${versionOf("wrangler")}`,
  `typescript@${versionOf("typescript")}`,
]);
step("npx", ["--no", "--", "wrangler", "types"]);
step("npx", ["--no", "--", "tsc", "--project", "."]);
step("npx", ["--no", "--", "wrangler", "deploy", "--dry-run", "--outdir", "bundle"]);

console.log("[check-package] ok: the packed package installs, typechecks, and bundles");
if (!keep) {
  rmSync(work, { recursive: true, force: true });
}
