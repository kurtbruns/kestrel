/**
 * Fails a Worker test that logs an error-level event it did not allow with
 * `allowErrorLogs` (`test/support/log.ts`). An error line means a reader could be mailed
 * twice or a send has not gone out (the level rule in `src/lib/log.ts`), so one a test did
 * not ask for is a finding, not output to scroll past. It wraps the logger itself rather
 * than the console, so a spec's console spies (and `vi.restoreAllMocks`) can't hide a line
 * from it.
 *
 * A line counts against the test running when it is logged, so a test that leaves work to
 * `waitUntil` must drain it (`waitOnExecutionContext`) before it ends, or a failure in that
 * work lands on whichever test runs next.
 */

import { afterEach, beforeEach } from "vitest";
import { type LogEventAt, type LogFields, log } from "../src/lib/log";
import { errorGuard } from "./support/log";

// How many frames of the logging call's stack a failure shows: enough to reach from the
// `log.error` call through the route or sweep that made it, which also names the test that
// started work it left to `waitUntil`.
const STACK_FRAMES = 8;

const logError = log.error;
log.error = (event: LogEventAt<"error">, fields: LogFields = {}): void => {
  // Drop the "Error" line and this wrapper's own frame, so the first frame is the caller,
  // and the test runner's frames, which say nothing about where the line came from.
  const at = (new Error().stack ?? "")
    .split("\n")
    .slice(2)
    .filter((frame) => !frame.includes("node_modules") && !frame.includes("(<anonymous>)"))
    .slice(0, STACK_FRAMES)
    .join("\n");
  errorGuard.record({ ...fields, event, level: "error" }, at);
  logError(event, fields);
};

beforeEach(() => {
  errorGuard.reset();
});

afterEach(() => {
  const problems = errorGuard.problems();
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\n(A line this test doesn't cause can be an earlier test's undrained waitUntil work.)`,
    );
  }
});
