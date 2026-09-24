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
