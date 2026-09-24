/**
 * A provider that never answers, for the adapters' timeout specs. `fetch` hangs until the
 * request's own signal aborts it, as the platform's fetch does, and the adapter's timeout
 * fires at once instead of after thirty real seconds, so a spec sees what the adapter makes
 * of an ended request without waiting for one.
 */
import { vi } from "vitest";

/** Hang every `fetch` until its signal aborts, and fire every `AbortSignal.timeout` at once.
 *  Returns the timeout spy, to check the duration asked for, and the reason the abort
 *  carries, which the adapter's rejection should be. */
export function neverAnswers() {
  const reason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(reason));
    return controller.signal;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return new Promise<Response>((_, reject) => {
      if (!signal) {
        // With no signal nothing would ever end it; fail loud rather than hang the spec.
        reject(new Error("request carries no signal"));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  });
  return { timeout, reason };
}
