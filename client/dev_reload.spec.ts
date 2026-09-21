import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AssetStamps,
  parseIndex,
  planReload,
  readStamps,
  startDevReload,
  swapStylesheet,
} from "./dev_reload";

const INDEX = (app: string, css: string) =>
  `<!doctype html><html><head><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="./styles.css?v=${css}"></head><body><script src="./app.js?v=${app}"></script></body></html>`;

describe("readStamps", () => {
  it("reads both ?v= stamps off index.html, ignoring other links and scripts", () => {
    const doc = parseIndex(
      `<html><head><link rel="stylesheet" href="./styles.css?v=c9770d9c"><link rel="stylesheet" href="https://fonts.example/x.css?v=zz"></head><body><script src="https://cdn.example/lib.js?v=9"></script><script src="./app.js?v=ce0c2717"></script></body></html>`,
    );
    expect(readStamps(doc)).toEqual({ app: "ce0c2717", css: "c9770d9c" });
  });

  it("reports null for an unstamped or absent reference", () => {
    expect(readStamps(parseIndex(`<script src="./app.js"></script>`))).toEqual({
      app: null,
      css: null,
    });
    expect(readStamps(parseIndex(`<p>no assets</p>`))).toEqual({ app: null, css: null });
  });
});

describe("planReload", () => {
  const loaded: AssetStamps = { app: "a1", css: "c1" };

  it("is a no-op while both stamps match", () => {
    expect(planReload(loaded, { app: "a1", css: "c1" })).toBe("none");
  });

  it("swaps the stylesheet when only its stamp changed", () => {
    expect(planReload(loaded, { app: "a1", css: "c2" })).toBe("swap-css");
  });

  it("reloads when the bundle changed, even if the stylesheet did too", () => {
    expect(planReload(loaded, { app: "a2", css: "c1" })).toBe("reload");
    expect(planReload(loaded, { app: "a2", css: "c2" })).toBe("reload");
  });

  it("never reloads on a missing stamp (a partial or malformed index.html)", () => {
    expect(planReload(loaded, { app: null, css: null })).toBe("none");
    expect(planReload({ app: null, css: null }, { app: "a2", css: "c2" })).toBe("none");
  });
});

const hrefs = () =>
  [...document.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));

/**
 * Take over the `load`/`error` listeners of every <link> the swap creates, so the test
 * decides when each "loads". happy-dom (with file loading off) fires `load` synchronously
 * on insertion, which would hide the in-flight state the no-flash contract is about.
 */
function captureLinkLoads(): Array<() => void> {
  const loads: Array<() => void> = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = create(tag);
    if (tag === "link") {
      vi.spyOn(el, "addEventListener").mockImplementation((_type, handler) => {
        loads.push(handler as () => void);
      });
    }
    return el;
  });
  return loads;
}

describe("swapStylesheet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts the new link beside the old and retires the old only once the new has loaded", () => {
    document.head.innerHTML = `<link rel="stylesheet" href="./styles.css?v=old">`;
    const loads = captureLinkLoads();
    expect(swapStylesheet(document, "new")).toBe(true);
    expect(hrefs()).toEqual(["./styles.css?v=old", "./styles.css?v=new"]);
    loads[0]!();
    expect(hrefs()).toEqual(["./styles.css?v=new"]);
  });

  it("keeps the newest stylesheet last and alone when two swaps overlap, whichever loads first", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      document.head.innerHTML = `<link rel="stylesheet" href="./styles.css?v=c1">`;
      const loads = captureLinkLoads();
      swapStylesheet(document, "c2");
      swapStylesheet(document, "c3"); // before c2 has loaded
      expect(hrefs()).toEqual(["./styles.css?v=c1", "./styles.css?v=c2", "./styles.css?v=c3"]);
      // Each fresh link registered load + error; index 0/2 are the two loads.
      for (const i of order) {
        loads[i * 2]!();
      }
      expect(hrefs()).toEqual(["./styles.css?v=c3"]);
      vi.restoreAllMocks();
    }
  });

  it("does nothing when there is no stylesheet link to swap", () => {
    document.head.innerHTML = "";
    expect(swapStylesheet(document, "new")).toBe(false);
  });
});

describe("startDevReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = `<link rel="stylesheet" href="./styles.css?v=c1">`;
    document.body.innerHTML = `<script src="./app.js?v=a1"></script>`;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads when index.html reports a new bundle stamp", async () => {
    const reload = vi.fn();
    const fetchIndex = vi.fn().mockResolvedValue(INDEX("a2", "c1"));
    const stop = startDevReload({ fetchIndex, reload, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests the reload once, then stops: a declined leave prompt is not re-asked", async () => {
    const reload = vi.fn();
    const fetchIndex = vi.fn().mockResolvedValue(INDEX("a2", "c1"));
    startDevReload({ fetchIndex, reload, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchIndex).toHaveBeenCalledTimes(1);
  });

  it("hot-swaps the stylesheet, then treats the new stamp as current", async () => {
    const reload = vi.fn();
    const fetchIndex = vi.fn().mockResolvedValue(INDEX("a1", "c2"));
    const stop = startDevReload({ fetchIndex, reload, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(reload).not.toHaveBeenCalled();
    // happy-dom fires the new link's load at once, so the old one is already retired.
    expect(hrefs()).toEqual(["./styles.css?v=c2"]);
    // A second tick with the same stamps must not swap again.
    await vi.advanceTimersByTimeAsync(60);
    expect(hrefs()).toEqual(["./styles.css?v=c2"]);
    stop();
  });

  it("ignores a failed fetch and keeps polling", async () => {
    const reload = vi.fn();
    const fetchIndex = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(INDEX("a2", "c1"));
    const stop = startDevReload({ fetchIndex, reload, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops polling once stopped", async () => {
    const fetchIndex = vi.fn().mockResolvedValue(INDEX("a1", "c1"));
    const stop = startDevReload({ fetchIndex, reload: vi.fn(), intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchIndex).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchIndex).toHaveBeenCalledTimes(1);
  });
});
