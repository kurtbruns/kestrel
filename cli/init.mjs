/*
 * `kestrel init [dir]`: write a new instance repository from the scaffold this release ships.
 *
 * Run as `npx kestrel init` in an empty repository: the client (packages/kestrel) fetches this
 * package at its own version and hands init to it. The scaffold lives in
 * `template/` and ships in the package, so a new instance always matches the release that
 * creates it. It writes the instance's package.json (pinning this exact release), its
 * wrangler config and one-line Worker entry, `.dev.vars.example`, the Claude context with its
 * headers (cli/context.mjs), and this release's migrations.
 *
 * The scaffold's wrangler config names the Worker, the D1 database, and the R2 bucket
 * `kestrel…`; init renames each after the instance (the folder's name, or `--name`), so a
 * second instance in the same Cloudflare account never deploys over the first or collides
 * with its database and bucket. An instance already written keeps the names it has.
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

// The longest name init derives is `<name>-media-production`, and an R2 bucket's name, like a
// Worker's on workers.dev, is at most 63 characters. Each resource takes lowercase letters,
// digits, and hyphens, never a hyphen at either end: the rules R2 and workers.dev share, and
// D1 accepts. Every name init makes ends in a suffix (`-dev`, `-production`), so no instance's
// name can make another's: the development Worker's `NAME-dev` never equals a production
// `OTHER-production`. `kestrel` alone is refused, being what instances made by earlier
// releases are named.
const NAME_MAX = 63 - "-media-production".length;
const NAME_RULE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Why `name` can't name an instance's resources, or null when it can. */
export function nameRefusal(name) {
  if (name.length > NAME_MAX) {
    return `"${name}" is ${name.length} characters; an instance's name is at most ${NAME_MAX}`;
  }
  if (!NAME_RULE.test(name)) {
    return `"${name}" isn't a valid instance name: use lowercase letters, digits, and hyphens, starting and ending with a letter or digit`;
  }
  if (name === "kestrel") {
    return `"kestrel" names the instances made by earlier releases, so a new one takes a name of its own`;
  }
  return null;
}

/**
 * The instance name a folder's name makes: accents dropped (`Café` is `cafe`), each run of
 * other characters a hyphen, or `newsletter` when nothing is left.
 */
export function nameFromFolder(dir) {
  const name = basename(dir)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/, "");
  return name || "newsletter";
}

// The scaffold's resource names: `kestrel`, then a suffix such as `-media-production`.
const RESOURCE_NAME = /("(?:name|database_name|bucket_name)":\s*")kestrel((?:-[a-z]+)*")/g;
const RESOURCE_COUNT = 6;

/** The scaffold's wrangler config with its Worker, database, and bucket named after `name`. */
export function nameResources(config, name) {
  let count = 0;
  const named = config.replace(RESOURCE_NAME, (_, key, suffix) => {
    count++;
    return `${key}${name}${suffix}`;
  });
  // A scaffold whose names this no longer finds would write an instance named `kestrel`.
  if (count !== RESOURCE_COUNT) {
    throw new Error(`template/wrangler.jsonc names ${count} resources, not ${RESOURCE_COUNT}`);
  }
  return named;
}

/** The instance directory and the `--name` flag's value, if given, from init's arguments. */
export function parseInitArgs(argv) {
  let dir;
  let name;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      name = argv[++i] ?? "";
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (!arg.startsWith("-") && dir === undefined) {
      dir = arg;
    }
  }
  return { dir: dir ?? ".", name };
}

/** `kestrel init [dir] [--name <name>]`. */
export function initCommand(argv) {
  const args = parseInitArgs(argv);
  const root = resolve(args.dir);
  const name = args.name ?? nameFromFolder(root);
  const refusal = nameRefusal(name);
  if (refusal) {
    const hint = args.name === undefined ? " Name it with --name, or rename the folder." : "";
    console.error(`[init] refused: ${refusal}.${hint}`);
    process.exit(1);
  }
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
  // @types/node is there only so `wrangler types` finds Node types installed (the Worker has
  // nodejs_compat) and stops ending the typecheck with "Action required"; the scaffold's
  // tsconfig lists no `types`, so they never enter the program and the Worker's types win.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.name = args.name ?? packageName(root);
  pkg.dependencies[PACKAGE.name] = PACKAGE.version;
  pkg.devDependencies["@types/node"] = PACKAGE.devDependencies["@types/node"];
  pkg.devDependencies.typescript = PACKAGE.devDependencies.typescript;
  pkg.devDependencies.wrangler = PACKAGE.peerDependencies.wrangler;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const config = join(root, "wrangler.jsonc");
  writeFileSync(config, nameResources(readFileSync(config, "utf8"), name));
  for (const file of CONTEXT_FILES) {
    writeShipped(root, file);
  }
  syncMigrationsCommand(root);

  // A path from here when the instance is below this directory, else the absolute one.
  const rel = relative(process.cwd(), root);
  const where = rel.startsWith("..") ? root : rel;
  console.log(`[init] a Kestrel ${PACKAGE.version} instance${where ? ` in ${where}` : ""}.`);
  console.log(
    `[init] named ${name}${args.name === undefined ? " after its folder (--name picks another)" : ""}: ` +
      `Worker and database ${name}-production, image bucket ${name}-media-production. Next:`,
  );
  console.log(
    [
      ...(where ? [`  cd ${where}`] : []),
      "  npm install",
      "  cp .dev.vars.example .dev.vars",
      "  npm run dev",
      "Then commit, and follow the setup guide to deploy: https://getkestrel.dev/docs/",
      "(offline: node_modules/@kurtbruns/kestrel/docs/README.md)",
    ].join("\n"),
  );
}
