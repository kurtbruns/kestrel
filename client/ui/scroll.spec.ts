import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { holdInView } from "./scroll";

describe("holdInView", () => {
  let target: HTMLElement;
  let content: HTMLElement;
  let scrolled: Mock<HTMLElement["scrollIntoView"]>;
  let grow: () => void;
  let disconnected: number;
  // Every hold ends with its test, so none is left listening on the window for the next.
  let views: AbortController[] = [];
  const controller = () => {
    const c = new AbortController();
    views.push(c);
    return c;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    content = document.createElement("div");
    target = document.createElement("h2");
    content.append(target);
    scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    disconnected = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(fn: () => void) {
          grow = fn;
        }
        observe() {}
        disconnect() {
          disconnected++;
        }
      },
    );
  });
  afterEach(() => {
    for (const c of views) {
      c.abort();
    }
    views = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("scrolls at once and again each time the content changes size", () => {
    holdInView(target, content, controller().signal);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    grow();
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])("lets go on %s", (type) => {
    holdInView(target, content, controller().signal);
    expect(disconnected).toBe(0);
    window.dispatchEvent(new Event(type));
    expect(disconnected).toBe(1);
  });

  it("lets go a few seconds after the page first paints, however long that took", () => {
    holdInView(target, content, controller().signal);
    // A background tab paints nothing, so it may sit like this for any length of time.
    vi.advanceTimersByTime(60_000);
    expect(disconnected).toBe(0);
    grow();
    expect(scrolled).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4999);
    grow();
    expect(disconnected).toBe(0);
    vi.advanceTimersByTime(1);
    expect(disconnected).toBe(1);
  });

  it("lets go when its view ends", () => {
    const c = controller();
    holdInView(target, content, c.signal);
    c.abort();
    expect(disconnected).toBe(1);
  });

  it("lets go when released", () => {
    const release = holdInView(target, content, controller().signal);
    release();
    expect(disconnected).toBe(1);
  });
});
