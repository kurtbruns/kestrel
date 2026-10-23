/*
 * How the client hands an instance command to the instance package, so `kestrel <command>`
 * stays one entry point although the commands live in two packages.
 *
 * `init`, `dev`, `seed`, `reset`, `sync-migrations`, and `check-context` act on an instance's
 * repository and belong to the release it runs, so they live in `@kurtbruns/kestrel`, which
 * each instance installs and pins. The client finds that install from the directory it runs
 * in, the way Node resolves an import from there, and runs its `kestrel` command with the same
 * arguments. `init` alone runs where nothing is installed yet: it fetches the instance package
 * at the client's own version through npx, so `npx kestrel@X.Y.Z init` writes an X.Y.Z
 * instance. Plain Node, no dependency, as the whole client is.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";

/** The package that holds the instance commands. */
export const INSTANCE_PACKAGE = "@kurtbruns/kestrel";

/** The commands that act on an instance's repository, and so run from the instance package. */
export const INSTANCE_COMMANDS = [
  "init",
  "dev",
  "sync-migrations",
  "check-context",
  "seed",
  "reset",
];

/**
 * The instance package as installed for `dir` (or a directory above it): `{ root, bin }`, with
 * `bin` the path of its `kestrel` script, or undefined when the install has none; or undefined
 * when no install is found.
 */
export function findInstance(dir = process.cwd()) {
  let manifest;
  try {
    manifest = createRequire(join(dir, "package.json")).resolve(`${INSTANCE_PACKAGE}/package.json`);
  } catch {
    return undefined;
  }
  const root = dirname(manifest);
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const script = typeof bin === "string" ? bin : bin?.kestrel;
  return { root, bin: script ? join(root, script) : undefined };
}

/** One argument for cmd.exe, which splits on spaces and reads its own metacharacters. */
function quoteForCmd(arg) {
  return /^[\w@=./:\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * How to run instance `command`, as `{ cmd, args, shell }`, or `{ refuse }` with words for the
 * person when there is no install to run it from. `version` is the client's, which `init`
 * fetches when nothing is installed. `KESTREL_INSTANCE_PACKAGE` names another package spec to
 * fetch, such as a packed tarball, which the package check uses before a release exists.
 */
export function handoff(
  command,
  argv,
  { dir = process.cwd(), version, env = process.env, platform = process.platform } = {},
) {
  const found = findInstance(dir);
  if (found?.bin) {
    return { cmd: process.execPath, args: [found.bin, command, ...argv], shell: false };
  }
  if (found) {
    return {
      refuse: `the ${INSTANCE_PACKAGE} installed at ${found.root} has no kestrel command, so it can't run \`kestrel ${command}\`. Reinstall it with \`npm install\`.`,
    };
  }
  if (command === "init") {
    const spec = env.KESTREL_INSTANCE_PACKAGE || `${INSTANCE_PACKAGE}@${version}`;
    const args = ["--yes", `--package=${spec}`, "--", "kestrel", command, ...argv];
    // npx is a .cmd script on Windows, which Node spawns only through a shell, and a shell
    // splits what it is given: so it gets one command line, each argument quoted for cmd.exe.
    if (platform === "win32") {
      return { cmd: ["npx.cmd", ...args].map(quoteForCmd).join(" "), args: [], shell: true };
    }
    return { cmd: "npx", args, shell: false };
  }
  return {
    refuse: `\`kestrel ${command}\` runs in an instance's repository, with ${INSTANCE_PACKAGE} installed, and none is installed here. Run it in your instance's repository after \`npm install\`, or write a new instance with \`npx kestrel init\`.`,
  };
}

// The signals passed on to the child when they are sent to this process alone.
const FORWARDED = ["SIGTERM", "SIGHUP", "SIGQUIT"];

/**
 * Run instance `command` through the instance package, with the terminal attached, and exit
 * as it does. A Ctrl-C reaches the child from the terminal itself, so this process only waits
 * for it to finish (`kestrel dev` stops its server on the way out); another signal sent to
 * this process alone is passed on. A child ended by a signal exits 128 plus its number, as a
 * shell reports it.
 */
export function runInstanceCommand(command, argv, version) {
  const plan = handoff(command, argv, { version });
  if (plan.refuse) {
    console.error(`kestrel: ${plan.refuse}`);
    process.exit(1);
  }
  const child = spawn(plan.cmd, plan.args, { stdio: "inherit", shell: plan.shell });
  process.on("SIGINT", () => {});
  for (const signal of FORWARDED) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (err) => {
    console.error(`kestrel: could not run ${INSTANCE_PACKAGE}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 0));
  });
}
