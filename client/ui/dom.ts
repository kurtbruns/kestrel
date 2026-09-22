// Querying markup a module itself rendered: the ids and classes are the module's own, so
// an element that is missing is a bug in its template, not a state to handle. These fail
// loud, naming the selector, instead of returning null for every call site to re-check.

/** The one element a selector matches under `root`, or a loud failure naming it. */
export function $<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const el = root.querySelector<T>(selector);
  if (!el) {
    throw new Error(`no element matches ${selector}`);
  }
  return el;
}

/** Every element a selector matches under `root`, as an array. */
export function $$<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return [...root.querySelectorAll<T>(selector)];
}
