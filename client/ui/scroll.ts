// Scrolling to something on a page that is still settling, where content above it can grow
// after the jump and carry it out of place.

// Long enough for a page's late content on a slow connection; a reader who hasn't touched
// the page by then is reading it, and any later growth is left to the browser.
const HOLD_MS = 5000;

// What a reader does to take the scroll over. A scrollbar drag counts where the browser reports
// it as a pointerdown; where it doesn't, the hold only moves the page if the page resizes.
const TAKEOVER = ["wheel", "touchstart", "pointerdown", "keydown"];

/**
 * Scroll `target` to the top of the window and keep it there while `content` changes size,
 * until the reader takes over, a few seconds pass, the signal aborts, or the returned
 * function is called.
 */
export function holdInView(target: HTMLElement, content: Element, signal: AbortSignal): () => void {
  target.scrollIntoView({ block: "start" });
  if (signal.aborted || typeof ResizeObserver === "undefined") {
    return () => {};
  }
  const stop = new AbortController();
  const release = () => stop.abort();
  // The observer first answers on the first frame the page paints, so the seconds count from
  // then: a link opened in a background tab still lands in place when the reader gets to it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = new ResizeObserver(() => {
    target.scrollIntoView({ block: "start" });
    timer ??= setTimeout(release, HOLD_MS);
  });
  watch.observe(content);
  for (const type of TAKEOVER) {
    window.addEventListener(type, release, { capture: true, passive: true, signal: stop.signal });
  }
  signal.addEventListener("abort", release, { signal: stop.signal });
  stop.signal.addEventListener(
    "abort",
    () => {
      watch.disconnect();
      clearTimeout(timer);
    },
    { once: true },
  );
  return release;
}
