/**
 * Read back what the structured log (`src/lib/log.ts`) wrote through a console spy: each
 * call is one JSON line, so a spec asserts on its event and fields rather than on text.
 */
import type { MockInstance } from "vitest";

export interface LoggedLine {
  event: string;
  level: string;
  [field: string]: unknown;
}

/** Every structured line the spy caught, parsed; anything else the runtime printed is left out. */
export function logged(spy: MockInstance): LoggedLine[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.startsWith("{"))
    .map((text) => JSON.parse(text) as LoggedLine);
}
