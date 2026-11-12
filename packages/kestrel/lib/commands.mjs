/*
 * The `kestrel` commands, once: their names, where each runs, and the help that lists them, and
 * the dispatch both `kestrel` scripts share.
 *
 * Two packages ship a `kestrel` script. The unscoped `kestrel` (packages/kestrel/bin) is the
 * client, which runs from anywhere and hands an instance command to the instance package
 * installed where it runs (lib/handoff.mjs); `@kurtbruns/kestrel` (bin/kestrel.mjs) runs every
 * command from its own install. Each script says only how it runs each command; the list, each
 * command's usage, the help, `--version`, an unknown command, and how a command's error is
 * printed are here, so the two can't drift apart. Plain Node, no dependency, as the whole client is.
 */
import { CliError, errorText, runCommand } from "./errors.mjs";
import { CLAUDE_CODE_CLIENT, KESTREL_CLI_CLIENT } from "./oauth.mjs";

/** The package that holds the instance commands. */
export const INSTANCE_PACKAGE = "@kurtbruns/kestrel";

/**
 * Every command, in the order the help lists them: `instance` for one that acts on an
 * instance's repository and so runs from the instance package, `client` for one that acts as
 * the person at this computer. `usage` is what `kestrel <command> --help` prints, kept here
 * rather than beside each command so the client can answer it for an instance command with no
 * instance package installed; its first line is the command's row in `kestrel --help`.
 */
export const COMMANDS = [
  {
    name: "init",
    runs: "instance",
    summary: "write a new instance repository here (or in dir)",
    usage: `Usage: kestrel init [dir] [--name <name>]

  Write a new instance repository here, or in dir, from the scaffold this release ships.
  Nothing is written if any file it would write is already there.

  --name <name>   names the Worker, database, and image bucket (default: the folder's name)`,
  },
  {
    name: "dev",
    runs: "instance",
    summary: "run locally, with the send sweep once a minute",
    usage: `Usage: kestrel dev [wrangler dev options]

  Run the Worker locally as it runs deployed: the send sweep once a minute, on the minute,
  the local database migrated when it is new, and this run recorded so seed and reset find it.
  Options go on to wrangler dev (--remote, for one), except --port: set PORT instead.

  PORT=<port>                    the port to serve on (default 8787, else a free one)
  SIMULATE_SENDS=<profile>       a provider simulation for this run, over .dev.vars's
  SIMULATE_ACCOUNT, MIN_LEAD_SECONDS, SUBREQUEST_BUDGET   likewise, for this run`,
  },
  {
    name: "sync-migrations",
    runs: "instance",
    summary: "copy this release's migrations into migrations/",
    usage: `Usage: kestrel sync-migrations

  Copy this release's migrations into migrations/. A file already there is never overwritten.`,
  },
  {
    name: "check-context",
    runs: "instance",
    summary: "show what this release changed in .claude/",
    usage: `Usage: kestrel check-context [--update] [--from <release>]

  Show what this release changed in the Claude files in .claude/, beside your own edits.

  --update            take this release's copy of each file you haven't edited, and add new ones
  --from <release>    compare from that release, not the one your last commit's package.json pins`,
  },
  {
    name: "seed",
    runs: "instance",
    summary: "load the demo publication into the local dev server",
    usage: `Usage: kestrel seed [--size <n>] [--seed <s>] [port|url]

  Load the demo publication into the local dev server, replacing what it holds.
  With no port or url, it acts only on the dev server this directory's kestrel dev started.

  --size <n>   scale the list to about n subscribers: 100, 1k, 10k, or 100k
  --seed <s>   pin the generator, so a scaled list comes out the same each time`,
  },
  {
    name: "reset",
    runs: "instance",
    summary: "return the local dev server to a fresh install",
    usage: `Usage: kestrel reset [port|url]

  Return the local dev server to a fresh install: no posts, subscribers, or settings.
  With no port or url, it acts only on the dev server this directory's kestrel dev started.`,
  },
  {
    name: "login",
    runs: "client",
    summary: "sign in to a deployed instance as you, in your browser",
    usage: `Usage: kestrel login <url> [--no-browser]

  Sign this computer in to a deployed instance as you, approving it in your browser.

  --no-browser   print the sign-in URL without opening a browser`,
  },
  {
    name: "logout",
    runs: "client",
    summary: "sign out of it on this computer",
    usage: `Usage: kestrel logout [url]

  Sign this computer out of an instance; the url may be left out when you're signed in to one.`,
  },
  {
    name: "api",
    runs: "client",
    summary: "call the API as you, or list and describe its routes",
    usage: `Usage: kestrel api <method> <path> [options]
       kestrel api --list [resource]       the instance's routes, or one resource's
       kestrel api help <method> <path>    one route: its fields, refusals, and answer

  -f, --raw-field <name=value>  a body field, as a string; repeatable. On a GET, or for a name
                                the route takes only as one, a query parameter
  -F, --field <name=value>      a body field typed by the route's schema (true, 3, null, JSON),
                                or name=@file for a file's text. name.sub nests; name[] lists
  --data <json|@file|->         the request body: inline, from a file, or from stdin
  --type <media type>           the body's type (default application/json)
  --form <name=value>           a multipart field, repeatable; name=@file attaches a file
  --url <url>                   the instance (default: KESTREL_URL, else this folder's instance, from
                                its wrangler.jsonc, else the only one you're signed in to)
  --local                       this directory's dev server, started by kestrel dev
  --client <name>               your own script's Kestrel-Client name (default ${CLAUDE_CODE_CLIENT}
                                when Claude Code runs this, otherwise ${KESTREL_CLI_CLIENT}); never
                                editor, which only the editor names itself

The routes, fields, and refusals come from the instance's own /api/openapi.json, so they
match the release it runs. A field the route doesn't take is refused before the request.`,
  },
];

/** The names of the commands that run from the instance package. */
export const INSTANCE_COMMANDS = COMMANDS.filter((c) => c.runs === "instance").map((c) => c.name);

/** What `kestrel <name> --help` prints. */
export function usageOf(name) {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    throw new Error(`no command named ${name}`);
  }
  return command.usage;
}

/** The help `kestrel` prints with no command, `help`, or `--help`. */
export function helpText(version) {
  // A command's row is the first line of its usage, after "Usage: kestrel ".
  const forms = COMMANDS.map((c) => [
    c.usage.split("\n")[0].replace(/^Usage: kestrel /, ""),
    c.summary,
  ]);
  const width = Math.max(...forms.map(([form]) => form.length)) + 2;
  const row = ([form, what]) => `  ${form.padEnd(width)}${what}`;
  const rows = (runs) => COMMANDS.flatMap((c, i) => (c.runs === runs ? [row(forms[i])] : []));
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
