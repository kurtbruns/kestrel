/*
 * The `kestrel` commands, once: their names, where each runs, and the help that lists them, and
 * the dispatch both `kestrel` scripts share.
 *
 * Two packages ship a `kestrel` script. The unscoped `kestrel` (packages/kestrel/bin) is the
 * client, which runs from anywhere and hands an instance command to the instance package
 * installed where it runs (lib/handoff.mjs); `@kurtbruns/kestrel` (bin/kestrel.mjs) runs every
 * command from its own install. Each script says only how it runs each command; the list, the
 * help, `--version`, an unknown command, and how a command's error is printed are here, so the
 * two can't drift apart. Plain Node, no dependency, as the whole client is.
 */
import { CliError, errorText, runCommand } from "./errors.mjs";

/** The package that holds the instance commands. */
export const INSTANCE_PACKAGE = "@kurtbruns/kestrel";

/**
 * Every command, in the order the help lists them: `instance` for one that acts on an
 * instance's repository and so runs from the instance package, `client` for one that acts as
 * the person at this computer. `usage` is its line in the help (more than one for a command
 * with more than one form).
 */
export const COMMANDS = [
  {
    name: "init",
    runs: "instance",
    usage: [["init [dir] [--name <name>]", "write a new instance repository here (or in dir)"]],
  },
  {
    name: "dev",
    runs: "instance",
    usage: [["dev [wrangler dev args]", "run locally, with the send sweep once a minute"]],
  },
  {
    name: "sync-migrations",
    runs: "instance",
    usage: [["sync-migrations", "copy this release's migrations into migrations/"]],
  },
  {
    name: "check-context",
    runs: "instance",
    usage: [["check-context [--update]", "show what this release changed in .claude/"]],
  },
  {
    name: "seed",
    runs: "instance",
    usage: [
      ["seed [--size <n>] [port|url]", "load the demo publication into the local dev server"],
    ],
  },
  {
    name: "reset",
    runs: "instance",
    usage: [["reset [port|url]", "return the local dev server to a fresh install"]],
  },
  {
    name: "login",
    runs: "client",
    usage: [
      ["login <url> [--no-browser]", "sign in to a deployed instance as you, in your browser"],
    ],
  },
  {
    name: "logout",
    runs: "client",
    usage: [["logout [url]", "sign out of it on this computer"]],
  },
  {
    name: "api",
    runs: "client",
    usage: [
      ["api <method> <path> [opts]", "call the API as you"],
      ["api --list | help <m> <path>", "list the instance's routes, or describe one"],
    ],
  },
];

/** The names of the commands that run from the instance package. */
export const INSTANCE_COMMANDS = COMMANDS.filter((c) => c.runs === "instance").map((c) => c.name);

const row = ([form, what]) => `  ${form.padEnd(30)}${what}`;

/** The help `kestrel` prints with no command, `help`, or `--help`. */
export function helpText(version) {
  const rows = (runs) => COMMANDS.filter((c) => c.runs === runs).flatMap((c) => c.usage.map(row));
  return [
    `kestrel ${version}`,
    "",
    "Usage: kestrel <command> [options]",
    "",
    `In an instance's repository, by its ${INSTANCE_PACKAGE} (init runs anywhere):`,
    ...rows("instance"),
    "",
    "As you, from anywhere:",
    ...rows("client"),
    "",
    row(["help, --help", "show this; kestrel <command> --help describes one"]),
    row(["version, --version", "print the version"]),
  ].join("\n");
}

/**
 * Run the command `argv` names, through `run`, the script's own runner for each command (every
 * command must have one), with its error printed under `kestrel <command>`.
 */
export async function main(argv, { version, run }) {
  const missing = COMMANDS.filter((c) => typeof run[c.name] !== "function");
  if (missing.length) {
    throw new Error(`no runner for ${missing.map((c) => c.name).join(", ")}`);
  }
  const [command, ...rest] = argv;
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(helpText(version));
      return;
  }
  if (!COMMANDS.some((c) => c.name === command)) {
    const err = new CliError(`unknown command "${command}"`, { after: helpText(version) });
    console.error(errorText("kestrel", err));
    process.exitCode = 1;
    return;
  }
  await runCommand(`kestrel ${command}`, () => run[command](rest));
}
