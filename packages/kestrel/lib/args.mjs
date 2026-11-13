/*
 * How a `kestrel` command reads its arguments: strictly, through Node's own `util.parseArgs`,
 * with `--help` and `-h` on every command.
 *
 * Strict because a command that writes files or wipes a database must never take a flag it
 * doesn't know for something else: read loosely, `kestrel init --help` writes an instance into
 * the folder, a misspelled `--name` names the instance after its folder, and `reset --help`
 * takes `--help` for a port. An unknown option, a missing value, or one positional too many is
 * refused with the command's usage, and nothing runs.
 *
 * `kestrel api` keeps its own reader (packages/kestrel/lib/api.mjs), since its `-f` and `-F`
 * fields interleave and its `help` is a subcommand; it is as strict, and answers `--help` the
 * same way. `kestrel dev` passes its arguments on to `wrangler dev`, so it only answers `--help`.
 *
 * It lives in the client because the instance commands in cli/ may import the client, never the
 * other way round. Plain Node, no dependency, as the whole client is.
 */
import { parseArgs } from "node:util";
import { UsageError } from "./errors.mjs";

/** Whether `argv` asks for help, wherever it says so before a `--`, after which all is positional. */
export function asksForHelp(argv) {
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  return options.includes("--help") || options.includes("-h");
}

/**
 * Node's words for a refused command line, in this CLI's shorter form. They are read from
 * Node's English message, so a message this doesn't recognize is given as Node wrote it, never
 * with a blank where the option's name should be. An unexpected positional never reaches here:
 * positionals are always allowed, and `readArgs` counts them itself.
 */
function usageMessage(err) {
  const named = /'([^']+)'/.exec(err.message)?.[1];
  if (named && err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return `unknown option ${named}`;
  }
  // Node names the option as `--name <value>`, or `-n, --name` for one with a short form.
  if (
    named &&
    err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" &&
    /argument missing/.test(err.message)
  ) {
    return `${named
      .replace(/ <value>$/, "")
      .split(", ")
      .at(-1)} needs a value`;
  }
  return err.message;
}

/**
 * `argv` read against `options` (in `util.parseArgs`'s shape) with at most `max` positionals:
 * `{ values, positionals }`, or `{ help: true }` when it asks for help. Throws a UsageError,
 * carrying `usage`, for an option it doesn't know, a missing value, or a positional too many.
 */
export function readArgs(argv, { options = {}, max = 0 } = {}, usage = undefined) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    // `kestrel init --nmae x --help` asks for help, and is answered with it.
    if (asksForHelp(argv)) {
      return { help: true };
    }
    throw new UsageError(usageMessage(err), usage);
  }
  if (parsed.values.help) {
    return { help: true };
  }
  if (parsed.positionals.length > max) {
    throw new UsageError(`unexpected argument "${parsed.positionals[max]}"`, usage);
  }
  const { help: _help, ...values } = parsed.values;
  return { values, positionals: parsed.positionals };
}

/**
 * A command's arguments, read as `readArgs` reads them, or undefined when they ask for help, in
 * which case `usage` has been printed and the command has nothing more to do.
 */
export function commandArgs(usage, argv, spec) {
  const parsed = readArgs(argv, spec, usage);
  if (parsed.help) {
    console.log(usage);
    return undefined;
  }
  return parsed;
}
