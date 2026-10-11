/**
 * Read back what the structured log (`src/lib/log.ts`) wrote through console spies: each
 * call is one JSON line, so a spec asserts on its event and fields rather than on text.
 */
import type { MockInstance } from "vitest";

export interface LoggedLine {
  event: string;
  level: string;
  [field: string]: unknown;
}

/** Every structured line the spies caught, parsed, in the order they were written across
 *  all of them; anything else the runtime printed is left out. */
export function logged(...spies: MockInstance[]): LoggedLine[] {
  return spies
    .flatMap((spy) =>
      spy.mock.calls.map((call, i) => ({
        text: String(call[0]),
        at: spy.mock.invocationCallOrder[i] ?? 0,
      })),
    )
    .filter(({ text }) => text.startsWith("{"))
    .sort((a, b) => a.at - b.at)
    .map(({ text }) => JSON.parse(text) as LoggedLine);
}

/** What the error guard (`test/log_guard.ts`) holds for the running test. */
const guard = { errors: [] as LoggedLine[], expected: new Set<string>() };

/**
 * Declare the error-level events the running test causes on purpose. The guard fails a test
 * that logs an error-level event it did not declare, and one that declares an event it never
 * logs, so a declaration is also an assertion that the failure was not silent (SPEC §12).
 */
export function expectErrorLogs(...events: string[]): void {
  for (const event of events) {
    guard.expected.add(event);
  }
}

/** The guard's per-test state, for `test/log_guard.ts` alone. */
export const errorGuard = {
  reset(): void {
    guard.errors = [];
    guard.expected = new Set();
  },
  record(line: LoggedLine): void {
    guard.errors.push(line);
  },
  /** What is wrong with the test's error lines against its declarations, or nothing. */
  problems(): string[] {
    const seen = new Set(guard.errors.map((line) => line.event));
    const undeclared = guard.errors.filter((line) => !guard.expected.has(line.event));
    const missing = [...guard.expected].filter((event) => !seen.has(event));
    return [
      ...undeclared.map(
        (line) =>
          `logged ${line.event} at error level without expectErrorLogs("${line.event}"): ${JSON.stringify(line)}`,
      ),
      ...missing.map((event) => `declared expectErrorLogs("${event}") but never logged it`),
    ];
  },
};
