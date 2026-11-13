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
 * `--hostname` and `--sending` write the two hostnames the operator chose into the
 * `production` block, the same kind of edit: the app's hostname into the route's `pattern` and
 * `APP_ORIGIN`, the sending hostname into `SENDING_DOMAIN` and `FROM_ADDRESS`. Each is
 * optional, and a value not given keeps the scaffold's `example.com` placeholder, which the
 * Worker refuses to start on, so a value left unset fails loudly rather than deploying to a
 * workers.dev address. Init never guesses one from the other.
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

// A DNS label: letters, digits, and inner hyphens, at most 63 characters.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `host` can't be the `flag` hostname, or null when it can. */
export function hostnameRefusal(flag, host) {
  if (host === "") {
    return `${flag} takes a hostname, such as ${flag === "--hostname" ? "newsletter" : "send"}.mysite.com`;
  }
  if (/[/:]/.test(host)) {
    return `${flag} "${host}" isn't a bare hostname: give the name alone, with no scheme, path, or port`;
  }
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2 || host.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return `${flag} "${host}" isn't a hostname: use letters, digits, hyphens, and dots, such as ${flag === "--hostname" ? "newsletter" : "send"}.mysite.com`;
  }
  // An IP address, or any name whose last label is all digits, is no hostname DNS resolves.
  if (/^\d+$/.test(labels.at(-1))) {
    return `${flag} "${host}" isn't a hostname: an IP address can't be one, and a hostname ends in a name, such as .com`;
  }
  if (labels.slice(-2).join(".") === "example.com") {
    return `${flag} "${host}" is on example.com, the scaffold's placeholder: give your own hostname`;
  }
  return null;
}

// The production block's placeholders each flag replaces, as [pattern, replacement]. Each is
// matched by its key, so a scaffold whose value moved fails loudly instead of keeping a
// placeholder the operator was told is filled.
const HOSTNAME_VALUES = {
  hostname: [
    [/("pattern":\s*")newsletter\.example\.com(")/, (host) => host],
    [/("APP_ORIGIN":\s*")https:\/\/newsletter\.example\.com(")/, (host) => `https://${host}`],
  ],
  sending: [
    [/("SENDING_DOMAIN":\s*")send\.example\.com(")/, (host) => host],
    [/("FROM_ADDRESS":\s*")newsletter@send\.example\.com(")/, (host) => `newsletter@${host}`],
  ],
};

/**
 * The scaffold's wrangler config with the `production` block's hostnames filled in, each of
 * `hostname` (the app's) and `sending` (the sending hostname) only when given. The top level
 * is local development, so its values stay as they are.
 */
export function fillHostnames(config, { hostname, sending }) {
  const at = config.search(/"production":\s*\{/);
  if (at < 0) {
    throw new Error("template/wrangler.jsonc has no production block");
  }
  let production = config.slice(at);
  for (const [key, host] of Object.entries({ hostname, sending })) {
    if (host === undefined) {
      continue;
    }
    for (const [pattern, value] of HOSTNAME_VALUES[key]) {
      if (!pattern.test(production)) {
        throw new Error(`template/wrangler.jsonc's production block has no ${pattern.source}`);
      }
      production = production.replace(
        pattern,
        (_, before, after) => `${before}${value(host)}${after}`,
      );
    }
  }
  return config.slice(0, at) + production;
}

/** A flag's value from `argv` at `i`, as `--flag value` or `--flag=value`, or undefined. */
function flagValue(argv, i, flag) {
  if (argv[i] === flag) {
    return { value: argv[i + 1] ?? "", skip: 1 };
  }
  if (argv[i].startsWith(`${flag}=`)) {
    return { value: argv[i].slice(flag.length + 1), skip: 0 };
  }
  return undefined;
}

const INIT_FLAGS = ["--name", "--hostname", "--sending"];

/**
 * The instance directory and the `--name`, `--hostname`, and `--sending` values given, and
 * `unknown`, each other flag, when there are any: init refuses those rather than skip one, since
 * a mistyped `--host news.mysite.com` would otherwise scaffold into a folder of that name.
 */
export function parseInitArgs(argv) {
  let dir;
  const flags = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const found = INIT_FLAGS.map((flag) => [flag, flagValue(argv, i, flag)]).find(
      ([, read]) => read,
    );
    if (found) {
      flags[found[0].slice(2)] = found[1].value;
      i += found[1].skip;
    } else if (arg.startsWith("-")) {
      unknown.push(arg.split("=")[0]);
    } else if (dir === undefined) {
      dir = arg;
    }
  }
  return {
    dir: dir ?? ".",
    name: flags.name,
    hostname: flags.hostname,
    sending: flags.sending,
    ...(unknown.length > 0 ? { unknown } : {}),
  };
}

/** init's line saying which production hostnames it filled, and which still need editing. */
export function hostnamesLine(hostname, sending) {
  const filled = [
    ...(hostname ? [`the app on ${hostname} (route and APP_ORIGIN)`] : []),
    ...(sending ? [`sending from newsletter@${sending} (SENDING_DOMAIN and FROM_ADDRESS)`] : []),
  ];
  const left = [
    ...(hostname ? [] : ["the route's pattern and APP_ORIGIN (--hostname)"]),
    ...(sending ? [] : ["SENDING_DOMAIN and FROM_ADDRESS (--sending)"]),
  ];
  return [
    ...(filled.length ? [`[init] production: ${filled.join(", ")}.`] : []),
    ...(left.length
      ? [`[init] still on example.com in wrangler.jsonc's production block: ${left.join(", ")}.`]
      : []),
  ].join("\n");
}

/** `kestrel init [dir] [--name <name>] [--hostname <app hostname>] [--sending <sending hostname>]`. */
export function initCommand(argv) {
  const args = parseInitArgs(argv);
  if (args.unknown) {
    const named = args.unknown.join(", ");
    console.error(
      `[init] refused: init doesn't take ${named}; it takes ${INIT_FLAGS.slice(0, -1).join(", ")}, and ${INIT_FLAGS.at(-1)}.`,
    );
    process.exit(1);
  }
  const root = resolve(args.dir);
  const name = args.name ?? nameFromFolder(root);
  const refusal = nameRefusal(name);
  if (refusal) {
    const hint = args.name === undefined ? " Name it with --name, or rename the folder." : "";
    console.error(`[init] refused: ${refusal}.${hint}`);
    process.exit(1);
  }
  for (const flag of ["hostname", "sending"]) {
    const hostRefusal = args[flag] === undefined ? null : hostnameRefusal(`--${flag}`, args[flag]);
    if (hostRefusal) {
      console.error(`[init] refused: ${hostRefusal}.`);
      process.exit(1);
    }
  }
  // DNS names are case-insensitive, and the Worker compares origins as written.
  const hostname = args.hostname?.toLowerCase();
  const sending = args.sending?.toLowerCase();
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
  writeFileSync(
    config,
    fillHostnames(nameResources(readFileSync(config, "utf8"), name), { hostname, sending }),
  );
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
      `Worker and database ${name}-production, image bucket ${name}-media-production.`,
  );
  console.log(hostnamesLine(hostname, sending));
  console.log("[init] Next:");
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
