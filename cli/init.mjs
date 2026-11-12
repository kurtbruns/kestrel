/*
 * `kestrel init [dir]`: write a new instance repository from the scaffold this release ships.
 *
 * Run as `npx kestrel init` in an empty repository: the client (packages/kestrel) fetches this
 * package at its own version and hands init to it. The scaffold lives in
 * `template/` and ships in the package, so a new instance always matches the release that
 * creates it. It writes the instance's package.json (pinning this exact release), its
 * wrangler config and one-line Worker entry, `.dev.vars.example`, the Claude context
 * (cli/context.mjs), and this release's migrations.
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
import { commandArgs, readArgs } from "../packages/kestrel/lib/args.mjs";
import { usageOf } from "../packages/kestrel/lib/commands.mjs";
import { CliError } from "../packages/kestrel/lib/errors.mjs";
import { CONTEXT_FILES, writeShipped } from "./context.mjs";
import { PACKAGE, PACKAGE_ROOT } from "./package.mjs";
import { syncMigrations } from "./sync-migrations.mjs";

const TEMPLATE = join(PACKAGE_ROOT, "template");

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

const USAGE = usageOf("init");

const INIT_ARGS = { options: { name: { type: "string" } }, max: 1 };

/** The instance directory and the `--name` flag's value, if given, from init's arguments. */
function initArgs({ values, positionals }) {
  return { dir: positionals[0] ?? ".", name: values.name };
}

/**
 * Init's arguments as `{ dir, name }`, or `{ help: true }`. Throws a UsageError for anything
 * else, a misspelled flag included, which read loosely would name the instance after its folder.
 */
export function parseInitArgs(argv) {
  const parsed = readArgs(argv, INIT_ARGS);
  return parsed.help ? parsed : initArgs(parsed);
}

/**
 * Every file init writes, as `[source, path in the instance]`, with the migrations and Claude
 * context it writes by their own steps listed by path alone, `[undefined, path]`, so a
 * collision with any of them is found before anything is written.
 */
function plannedFiles() {
  const copies = [
    ...scaffoldFiles(),
    [join(PACKAGE_ROOT, ".dev.vars.example"), ".dev.vars.example"],
  ];
  // A migration of this release's already there counts too, since sync-migrations refuses
  // to overwrite one, and by then everything else would have been written.
  const migrations = readdirSync(join(PACKAGE_ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => [undefined, `migrations/${f}`]);
  return [...copies, ...CONTEXT_FILES.map((f) => [undefined, f]), ...migrations];
}

/** Refuse, writing nothing, when the name can't name the resources or a file is already there. */
function refuseInit(root, name, { named, files }) {
  const refusal = nameRefusal(name);
  if (refusal) {
    const hint = named ? "" : " Name it with --name, or rename the folder.";
    throw new CliError(`refused: ${refusal}.${hint}`);
  }
  const taken = files.map(([, to]) => to).filter((to) => existsSync(join(root, to)));
  if (taken.length > 0) {
    throw new CliError(
      `refused: ${taken.join(", ")} already exist${taken.length === 1 ? "s" : ""} in ${root}.`,
      {
        lines: [
          "Run init in an empty repository (created without a README, .gitignore, or license).",
        ],
      },
    );
  }
}

/**
 * The scaffold's package.json for instance `name`: pinning this exact release, and the tools at
 * the versions it was tested with. @types/node is there only so `wrangler types` finds Node
 * types installed (the Worker has nodejs_compat) and stops ending the typecheck with "Action
 * required"; the scaffold's tsconfig lists no `types`, so they never enter the program and the
 * Worker's types win.
 */
export function instancePackageJson(scaffold, name) {
  const pkg = JSON.parse(scaffold);
  pkg.name = name;
  pkg.dependencies[PACKAGE.name] = PACKAGE.version;
  pkg.devDependencies["@types/node"] = PACKAGE.devDependencies["@types/node"];
  pkg.devDependencies.typescript = PACKAGE.devDependencies.typescript;
  pkg.devDependencies.wrangler = PACKAGE.peerDependencies.wrangler;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Write the instance: the scaffold, its package.json and resource names, the context, the migrations. */
function writeInstance(root, name, files) {
  for (const [from, to] of files) {
    if (from) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      copyFileSync(from, join(root, to));
    }
  }
  const pkg = join(root, "package.json");
  writeFileSync(pkg, instancePackageJson(readFileSync(pkg, "utf8"), name));
  const config = join(root, "wrangler.jsonc");
  writeFileSync(config, nameResources(readFileSync(config, "utf8"), name));
  for (const file of CONTEXT_FILES) {
    writeShipped(root, file);
  }
  syncMigrations(root);
}

/** Say what was written and what to do next. */
function reportInit(root, name, { named }) {
  // A path from here when the instance is below this directory, else the absolute one.
  const rel = relative(process.cwd(), root);
  const where = rel.startsWith("..") ? root : rel;
  console.log(`[init] a Kestrel ${PACKAGE.version} instance${where ? ` in ${where}` : ""}.`);
  console.log(
    `[init] named ${name}${named ? "" : " after its folder (--name picks another)"}: ` +
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

/** `kestrel init [dir] [--name <name>]`. */
export function initCommand(argv) {
  const parsed = commandArgs(USAGE, argv, INIT_ARGS);
  if (!parsed) {
    return;
  }
  const args = initArgs(parsed);
  const root = resolve(args.dir);
  const name = args.name ?? nameFromFolder(root);
  const named = args.name !== undefined;
  const files = plannedFiles();
  refuseInit(root, name, { named, files });
  writeInstance(root, name, files);
  reportInit(root, name, { named });
}
