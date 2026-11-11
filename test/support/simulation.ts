/**
 * Resetting the local send simulation between tests: the provider's per-send state and the
 * receipts' floor are module state that lasts as long as the isolate, as a dev server's does,
 * so a spec that runs simulated sends clears both in its `beforeEach`.
 */

import { resetSimulatedReceipts } from "../../src/dev/simulated_receipts";
import { resetSimulatedSends } from "../../src/providers/simulate/provider";

/** Forget every simulated send, as a restarted dev server would. */
export function resetSimulation(): void {
  resetSimulatedSends();
  resetSimulatedReceipts();
}
