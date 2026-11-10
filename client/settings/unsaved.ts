// The leave guard of a page that saves by hand (Settings, the Template page): what the
// router asks before a navigation away or an unload, so unsaved edits are never dropped
// unasked, and how a leave waits for a save that is already on its way.

import type { ViewHandle } from "../lifecycle";

/** What a page that saves by hand offers the router, and the wrapper its save runs in. */
export interface UnsavedGuard {
  /** The page's ViewHandle members for its unsaved edits. */
  handle: Required<Pick<ViewHandle, "dirty" | "beforeLeave">>;
  /**
   * Run a save. While one runs, a leave neither prompts nor drops the edits: the page stays,
   * and once the save lands and nothing is left unsaved it follows to where the reader was
   * going. A save that was refused or declined, or edits typed while it ran, keep the page
   * where it is, the bar still up and saying why.
   */
  saving<T>(run: () => Promise<T>): Promise<T>;
}

/** The guard over `dirty`, the page's unsaved edits, for the mount `signal` belongs to. */
export function guardUnsaved(dirty: () => boolean, signal: AbortSignal): UnsavedGuard {
  let running = 0;
  // Where the latest leave asked during a save was going, followed once the save lands.
  let pending: string | null = null;
  return {
    handle: {
      dirty,
      beforeLeave() {
        if (running > 0) {
          pending = location.hash; // the router asks once the hash has moved
          return "stay";
        }
        return dirty() ? "confirm" : "leave";
      },
    },
    async saving(run) {
      running++;
      try {
        return await run();
      } finally {
        running--;
        const to = pending;
        if (running === 0 && to !== null) {
          pending = null;
          if (!signal.aborted && !dirty()) {
            location.hash = to;
          }
        }
      }
    },
  };
}
