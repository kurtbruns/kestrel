/**
 * Holds the package's declared Worker (src/worker.d.ts) against the real entry: the
 * typecheck fails when the entry stops satisfying what an instance is told it re-exports.
 * Type-only, never run.
 */

import worker from "../src/index";
import type declared from "../src/worker";

export const entrySatisfiesDeclaration: typeof declared = worker;
