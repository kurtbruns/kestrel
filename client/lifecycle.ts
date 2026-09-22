// The view lifecycle: one view is mounted at a time, into its own root under #app, with
// an AbortSignal that ends with it. Everything a view starts that could outlive it, a
// timer, a poll, a read that paints, a bar it borrowed, is bound to that signal, so
// navigating away tears the view down by construction, and the view never has to know
// whether it is still the one on screen.

import { app } from "./shell";

/**
 * What a mounted view offers the app around it. Every member is optional: a list view
 * offers nothing; the editor offers all three.
 */
export interface ViewHandle {
  /** Unsaved work the browser should warn about before the tab unloads. */
  dirty?(): boolean;
  /**
   * Asked once before a navigation away. The view may save in the background here and
   * answer "leave"; "confirm" has the router ask the reader first, and a declined prompt
   * keeps the view mounted.
   */
  beforeLeave?(): "leave" | "confirm";
  /** ⌘S / Ctrl-S. */
  manualSave?(): void;
}

// What a view hands back: a handle, or nothing (the async ones resolve to nothing, so
// this is `void`, not `undefined`, and the union is the honest type of that).
// biome-ignore lint/suspicious/noConfusingVoidType: see above
type Offered = ViewHandle | void;

/** A view: paints into `root`, binds what it starts to `signal`, and may return a handle. */
export type View = (root: HTMLElement, signal: AbortSignal) => Offered | Promise<Offered>;

let controller: AbortController | null = null;
let handle: ViewHandle | null = null;

/**
 * Tear the mounted view down and mount `view` in its place. The previous view's signal
 * aborts first, then a fresh root replaces its markup, so a stale continuation (a read
 * that resolved after the abort) paints into a detached element and nobody sees it. A
 * view re-enters itself the same way (a reload, a retry): the same abort, a fresh root.
 */
export function mount(view: View): Promise<void> {
  controller?.abort();
  handle = null;
  const c = new AbortController();
  controller = c;
  const root = document.createElement("div");
  root.className = "view";
  app.replaceChildren(root);
  // The view starts now, not in a microtask: a second mount in the same tick must find
  // it started (its signal listeners in place), or the abort would reach a view that
  // never ran and a promise that never settles.
  let outcome: Promise<Offered>;
  try {
    outcome = Promise.resolve(view(root, c.signal));
  } catch (e) {
    outcome = Promise.reject(e);
  }
  return outcome.then(
    (h) => {
      if (!c.signal.aborted && h) {
        handle = h;
      }
    },
    (e) => {
      // A view cut off mid-load is not an error; anything else is the view's own bug.
      if (!c.signal.aborted) {
        throw e;
      }
    },
  );
}

/** Tear the mounted view down and leave #app empty (the re-auth wall paints its own). */
export function unmount(): void {
  controller?.abort();
  controller = null;
  handle = null;
  app.replaceChildren();
}

/** The mounted view's handle, for the router's guards; null while nothing offers one. */
export function mounted(): ViewHandle | null {
  return handle;
}

/** Run `fn` every `ms` until the signal aborts. */
export function every(ms: number, fn: () => void, signal: AbortSignal): void {
  if (signal.aborted) {
    return;
  }
  const id = setInterval(fn, ms);
  signal.addEventListener("abort", () => clearInterval(id), { once: true });
}

// A tick's answer: `false` ends the poll; anything else (nothing, for a tick that always
// continues) keeps it going.
// biome-ignore lint/suspicious/noConfusingVoidType: see above
type Again = boolean | void;

/**
 * A repeating read that never overlaps itself: `tick` runs `ms` after the previous one
 * finished, until the signal aborts or a tick answers `false`. A tick's own reads take
 * the signal, so one in flight is cut off by navigation; a tick that throws (transient,
 * or cut off) simply yields to the next.
 */
export function poll(ms: number, tick: () => Promise<Again>, signal: AbortSignal): void {
  const arm = () => {
    if (signal.aborted) {
      return;
    }
    const cancel = () => clearTimeout(id);
    const id = setTimeout(async () => {
      signal.removeEventListener("abort", cancel);
      let again: boolean | undefined = true;
      try {
        again = (await tick()) ?? true;
      } catch {
        again = true;
      }
      if (again !== false) {
        arm();
      }
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  };
  arm();
}

/** Run `fn` when the signal aborts (at once if it already has). */
export function onAbort(signal: AbortSignal, fn: () => void): void {
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener("abort", fn, { once: true });
}

/** The DOMException an aborted read rejects with; a view's catch checks this before it reports an error. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
