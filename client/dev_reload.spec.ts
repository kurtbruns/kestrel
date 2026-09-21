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

describe("swapStylesheet", () => {
  it("inserts the new link beside the old and retires the old once the new has loaded", () => {
    document.head.innerHTML = `<link rel="stylesheet" href="./styles.css?v=old">`;
    expect(swapStylesheet(document, "new")).toBe(true);
    const links = document.head.querySelectorAll('link[rel="stylesheet"]');
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe("./styles.css?v=old");
    expect(links[1]!.getAttribute("href")).toBe("./styles.css?v=new");
    links[1]!.dispatchEvent(new Event("load"));
    const after = document.head.querySelectorAll('link[rel="stylesheet"]');
    expect(after).toHaveLength(1);
    expect(after[0]!.getAttribute("href")).toBe("./styles.css?v=new");
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

  it("hot-swaps the stylesheet, then treats the new stamp as current", async () => {
    const reload = vi.fn();
    const fetchIndex = vi.fn().mockResolvedValue(INDEX("a1", "c2"));
    const stop = startDevReload({ fetchIndex, reload, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(reload).not.toHaveBeenCalled();
    const links = document.head.querySelectorAll('link[rel="stylesheet"]');
    expect(links).toHaveLength(2);
    expect(links[1]!.getAttribute("href")).toBe("./styles.css?v=c2");
    // A second tick with the same stamps must not stack another link: exactly one
    // carries the new stamp, whether or not happy-dom has retired the old one yet.
    await vi.advanceTimersByTimeAsync(60);
    expect(document.head.querySelectorAll('link[rel="stylesheet"][href$="v=c2"]')).toHaveLength(1);
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
