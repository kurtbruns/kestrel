/**
 * Fails a Worker test that logs an error-level event it did not declare with
 * `expectErrorLogs` (`test/support/log.ts`). An error line means a reader could be mailed
 * twice or a send has not gone out (the level rule in `src/lib/log.ts`), so one a test did
 * not ask for is a finding, not output to scroll past. It wraps the logger itself rather
 * than the console, so a spec's console spies (and `vi.restoreAllMocks`) can't hide a line
 * from it.
 */

import { afterEach, beforeEach } from "vitest";
import { type LogFields, log } from "../src/lib/log";
import { errorGuard } from "./support/log";

const logError = log.error;
log.error = (event: string, fields: LogFields = {}): void => {
  errorGuard.record({ ...fields, event, level: "error" });
  logError(event, fields);
};

beforeEach(() => {
  errorGuard.reset();
});

afterEach(() => {
  const problems = errorGuard.problems();
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
});
