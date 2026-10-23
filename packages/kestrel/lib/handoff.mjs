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
 * The path of the instance package's `kestrel` script as installed for `dir` (or a directory
 * above it), or undefined when none is.
 */
export function instanceBin(dir = process.cwd()) {
  let manifest;
  try {
    manifest = createRequire(join(dir, "package.json")).resolve(`${INSTANCE_PACKAGE}/package.json`);
  } catch {
    return undefined;
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const script = typeof bin === "string" ? bin : bin?.kestrel;
  return script ? join(dirname(manifest), script) : undefined;
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
  const bin = instanceBin(dir);
  if (bin) {
    return { cmd: process.execPath, args: [bin, command, ...argv], shell: false };
  }
  if (command === "init") {
    const spec = env.KESTREL_INSTANCE_PACKAGE || `${INSTANCE_PACKAGE}@${version}`;
    // npx is a .cmd script on Windows, which Node spawns only through a shell.
    const windows = platform === "win32";
    return {
      cmd: windows ? "npx.cmd" : "npx",
      args: ["--yes", `--package=${spec}`, "--", "kestrel", command, ...argv],
      shell: windows,
    };
  }
  return {
    refuse: `\`kestrel ${command}\` runs in an instance's repository, with ${INSTANCE_PACKAGE} installed, and none is installed here. Run it in your instance's repository after \`npm install\`, or write a new instance with \`npx kestrel init\`.`,
  };
}

/**
 * Run instance `command` through the instance package, with the terminal attached, and exit
 * as it does. A Ctrl-C reaches the child from the terminal itself, so this process only waits
 * for it to finish (`kestrel dev` stops its server on the way out); a signal sent to this
 * process alone is passed on.
 */
export function runInstanceCommand(command, argv, version) {
  const plan = handoff(command, argv, { version });
  if (plan.refuse) {
    console.error(`kestrel: ${plan.refuse}`);
    process.exit(1);
  }
  const child = spawn(plan.cmd, plan.args, { stdio: "inherit", shell: plan.shell });
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", (err) => {
    console.error(`kestrel: could not run ${INSTANCE_PACKAGE}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}
