/**
 * Fails a client test that writes to the console's error stream without allowing it with
 * `allowConsoleErrors` (`client/test/support.ts`), the client's counterpart to the Worker's
 * `test/log_guard.ts`. No client module writes to the console, so an error line during a
 * spec is a view going wrong or happy-dom refusing something, and a passing run that prints
 * one buries the next real failure under it.
 *
 * It watches two ways out. A view's `console.error` and `console.warn` go through Vitest's
 * console, which drops a passing test's output, so it wraps those. happy-dom's own messages
 * (a refused frame or resource load) go through the Node console it was handed before
 * Vitest swapped in its own, straight to the process's stderr, past `silent` and past a
 * console spy, so it wraps that stream's `write` too. Both are wrapped by assignment, not a
 * spy, so a spec's `vi.restoreAllMocks()` doesn't take the guard away.
 *
 * A line counts against the test running when it is written, so one written after a test
 * ends (an unawaited timer, a frame that loads late) lands on the next test.
 */

import { afterEach, beforeEach } from "vitest";

// How much of a line a failure shows: the message and the top of its stack, enough to say
// what wrote it without reprinting the whole trace the guard exists to keep out of the run.
const SHOWN_LINES = 6;

/** What the guard holds for the running test. */
const guard = {
  lines: [] as string[],
  allowed: [] as (string | RegExp)[],
};

/**
 * Allow the console error lines the running test causes on purpose, each matched by a
 * substring or a pattern. The guard fails a test that writes any other. Allowing doesn't
 * assert the line was written; a test that means to prove it spies on the console.
 */
export function allowConsoleErrors(...matches: (string | RegExp)[]): void {
  guard.allowed.push(...matches);
}

/** The guard's per-test state, for this module and its own spec alone. */
export const consoleGuard = {
  reset(): void {
    guard.lines = [];
    guard.allowed = [];
  },
  record(line: string): void {
    guard.lines.push(line);
  },
  /** Each line the test wrote without allowing it, trimmed to its first few lines. */
  problems(): string[] {
    return guard.lines
      .filter(
        (line) =>
          !guard.allowed.some((m) => (typeof m === "string" ? line.includes(m) : m.test(line))),
      )
      .map((line) => line.split("\n").slice(0, SHOWN_LINES).join("\n"));
  },
};

function text(args: unknown[]): string {
  return args
    .map((arg) => (arg instanceof Error ? (arg.stack ?? String(arg)) : String(arg)))
    .join(" ");
}

for (const level of ["error", "warn"] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]): void => {
    consoleGuard.record(text(args));
    original.apply(console, args);
  };
}

// The client program carries the DOM's types, not Node's, so the one Node stream the guard
// needs is typed here.
interface WritableLike {
  write(chunk: unknown, ...rest: unknown[]): boolean;
}
const stderr = (globalThis as unknown as { process: { stderr: WritableLike } }).process.stderr;
const write = stderr.write;
stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
  consoleGuard.record(String(chunk));
  return write.call(stderr, chunk, ...rest);
};

beforeEach(() => {
  consoleGuard.reset();
});

afterEach(() => {
  const problems = consoleGuard.problems();
  if (problems.length > 0) {
    throw new Error(
      `wrote to the console's error stream without allowConsoleErrors(...):\n${problems.join("\n---\n")}\n(A line this test doesn't cause can be an earlier test's late work.)`,
    );
  }
});
