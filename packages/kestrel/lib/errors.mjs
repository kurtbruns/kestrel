/*
 * How a `kestrel` command says it can't go on: it throws a CliError with words for the person,
 * and the command's runner prints it once, under the command's name, and sets the exit status.
 *
 * One way, so no helper deep in a command decides to end the process: a command reads the same
 * whether it is run from a terminal or called from a spec or a script, which sees the error
 * thrown rather than a process gone. The runner sets `process.exitCode` rather than exiting, so
 * what a command already wrote to stdout reaches a pipe whole.
 *
 * Only a CliError is the person's to read as it is. Anything else thrown is a fault in the
 * command, and is printed with its stack, so it can be reported. Plain Node, no dependency, as
 * the whole client is.
 */

/**
 * A command that can't go on, in words for the person: `message` first, `lines` indented under
 * it (what to do, what was found), and `after`, such as a usage, printed below as it is.
 */
export class CliError extends Error {
  constructor(message, { lines = [], after } = {}) {
    super(message);
    this.name = "CliError";
    this.lines = lines;
    this.after = after;
  }
}

/** A command line the command can't run: what's wrong with it, and the command's usage after. */
export class UsageError extends CliError {
  constructor(message, usage) {
    super(message, { after: usage });
    this.name = "UsageError";
  }
}

/** The text a CliError prints under `name`: its message, its lines indented under it, then `after`. */
export function errorText(name, err) {
  const indent = " ".repeat(name.length + 2);
  const lines = [`${name}: ${err.message}`, ...err.lines.map((line) => `${indent}${line}`)];
  return err.after ? `${lines.join("\n")}\n\n${err.after}` : lines.join("\n");
}

/**
 * Run a command under `name` (`kestrel init`): a CliError it throws is printed on stderr and
 * the exit status set to 1; anything else is a fault, and is thrown on.
 */
export async function runCommand(name, command) {
  try {
    await command();
  } catch (err) {
    if (!(err instanceof CliError)) {
      throw err;
    }
    console.error(errorText(name, err));
    process.exitCode = 1;
  }
}
