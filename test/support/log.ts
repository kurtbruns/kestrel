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
const guard = {
  errors: [] as { line: LoggedLine; at: string }[],
  allowed: new Set<string>(),
};

/**
 * Allow the error-level events the running test causes on purpose. The guard fails a test
 * that logs any other error-level event. Allowing an event doesn't assert it was logged; a
 * test that means to prove the failure was loud reads the line back with `logged()`.
 */
export function allowErrorLogs(...events: string[]): void {
  for (const event of events) {
    guard.allowed.add(event);
  }
}

/** The guard's per-test state, for `test/log_guard.ts` alone. */
export const errorGuard = {
  reset(): void {
    guard.errors = [];
    guard.allowed = new Set();
  },
  /** Note an error line and `at`, the stack of the call that logged it. */
  record(line: LoggedLine, at: string): void {
    guard.errors.push({ line, at });
  },
  /** Each error line the test logged without allowing it, with where it was logged. */
  problems(): string[] {
    return guard.errors
      .filter(({ line }) => !guard.allowed.has(line.event))
      .map(
        ({ line, at }) =>
          `logged ${line.event} at error level without allowErrorLogs("${line.event}"): ${JSON.stringify(line)}\n${at}`,
      );
  },
};
