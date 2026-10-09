/*
 * `kestrel init [dir]`: write a new instance repository from the scaffold this release ships.
 *
 * Run as `npx @kurtbruns/kestrel init` in an empty repository. The scaffold lives in
 * `template/` and ships in the package, so a new instance always matches the release that
 * creates it. It writes the instance's package.json (pinning this exact release), its
 * wrangler config and one-line Worker entry, `.dev.vars.example`, the Claude context with its
 * headers (cli/context.mjs), and this release's migrations.
 *
 * A few files ship under other names and are renamed here: npm leaves `.gitignore` and
 * `.npmrc` out of a published package, and the Claude files sit outside `.claude/` so they
 * don't load into sessions in Kestrel's own repository. Init never overwrites: if any file it
 * would write exists already, it writes nothing and names them.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_FILES, writeShipped } from "./context.mjs";
import { syncMigrationsCommand } from "./sync-migrations.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(PACKAGE_ROOT, "template");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

// Shipped name → name in the instance.
const RENAMED = { gitignore: ".gitignore", npmrc: ".npmrc", claude: ".claude" };

/** Every scaffold file as [path in the package, path in the instance], context files aside. */
function scaffoldFiles(dir = TEMPLATE, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    if (entry.isDirectory()) {
      scaffoldFiles(from, out);
      continue;
    }
    // Split on either separator, so the names match on Windows too.
    const to = relative(TEMPLATE, from)
      .split(/[\\/]/)
      .map((part) => RENAMED[part] ?? part)
      .join("/");
    if (!CONTEXT_FILES.includes(to)) {
      out.push([from, to]);
    }
  }
  return out;
}

/** An npm package name made from the directory's name, or `newsletter`. */
function packageName(dir) {
  const name = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[-]+$/g, "");
  return name || "newsletter";
}

/** `kestrel init [dir]`. */
export function initCommand(argv) {
  const root = resolve(argv.find((a) => !a.startsWith("-")) ?? ".");
  const files = [
    ...scaffoldFiles(),
    [join(PACKAGE_ROOT, ".dev.vars.example"), ".dev.vars.example"],
  ];
  // A migration of this release's already there counts too, since sync-migrations refuses
  // to overwrite one, and by then everything else would have been written.
  const migrations = readdirSync(join(PACKAGE_ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => `migrations/${f}`);
  const writes = [...files.map(([, to]) => to), ...CONTEXT_FILES, ...migrations];
  const taken = writes.filter((to) => existsSync(join(root, to)));
  if (taken.length > 0) {
    console.error(
      `[init] refused: ${taken.join(", ")} already exist${taken.length === 1 ? "s" : ""} in ${root}.\n` +
        "Run init in an empty repository (created without a README, .gitignore, or license).",
    );
    process.exit(1);
  }

  for (const [from, to] of files) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    copyFileSync(from, join(root, to));
  }
  // The instance pins this exact release, and the tools at the versions it was tested with.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.name = packageName(root);
  pkg.dependencies[PACKAGE.name] = PACKAGE.version;
  pkg.devDependencies.typescript = PACKAGE.devDependencies.typescript;
  pkg.devDependencies.wrangler = PACKAGE.peerDependencies.wrangler;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const file of CONTEXT_FILES) {
    writeShipped(root, file);
  }
  syncMigrationsCommand(root);

  // A path from here when the instance is below this directory, else the absolute one.
  const rel = relative(process.cwd(), root);
  const where = rel.startsWith("..") ? root : rel;
  console.log(`[init] a Kestrel ${PACKAGE.version} instance${where ? ` in ${where}` : ""}. Next:`);
  console.log(
    [
      ...(where ? [`  cd ${where}`] : []),
      "  npm install",
      "  cp .dev.vars.example .dev.vars",
      "  npm run dev",
      "Then commit, and follow the setup guide (node_modules/@kurtbruns/kestrel/docs/README.md) to deploy.",
    ].join("\n"),
  );
}
