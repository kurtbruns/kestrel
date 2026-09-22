import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { every, mount, mounted, onAbort, poll, unmount } from "./lifecycle";
import { $, $$, resetShell } from "./test/support";

describe("lifecycle", () => {
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
  });
  afterEach(() => {
    unmount();
    vi.useRealTimers();
  });

  it("mounts a view into its own root under #app, and the next mount aborts it", async () => {
    let seen: AbortSignal | null = null;
    await mount((root, signal) => {
      seen = signal;
      root.textContent = "first";
    });
    expect($("#app").textContent).toBe("first");
    expect(seen!.aborted).toBe(false);
    await mount((root) => {
      root.textContent = "second";
    });
    expect(seen!.aborted).toBe(true);
    expect($("#app").textContent).toBe("second");
    expect($$("#app > .view")).toHaveLength(1);
  });

  it("keeps the mounted view's handle, and drops it on unmount", async () => {
    const handle = { dirty: () => true };
    await mount(() => handle);
    expect(mounted()).toBe(handle);
    unmount();
    expect(mounted()).toBeNull();
    expect($("#app").childElementCount).toBe(0);
  });

  it("does not adopt the handle of a view that finished after it was replaced", async () => {
    let finish: () => void = () => {};
    const stale = mount(async () => {
      await new Promise<void>((r) => (finish = r));
      return { dirty: () => true };
    });
    await mount(() => ({ dirty: () => false }));
    finish();
    await stale;
    expect(mounted()?.dirty?.()).toBe(false);
  });

  it("lets a replaced view's late paint land in a detached root, never on screen", async () => {
    let finish: () => void = () => {};
    const stale = mount(async (root) => {
      await new Promise<void>((r) => (finish = r));
      root.textContent = "stale"; // a read that resolved after the abort
    });
    await mount((root) => {
      root.textContent = "live";
    });
    finish();
    await stale;
    expect($("#app").textContent).toBe("live");
  });

  it("swallows a view cut off mid-load, and surfaces any other failure", async () => {
    const cutOff = mount(async (_root, signal) => {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))),
      );
    });
    await mount(() => undefined);
    await expect(cutOff).resolves.toBeUndefined();
    await expect(mount(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("every: runs on the interval until the signal aborts", () => {
    const c = new AbortController();
    const fn = vi.fn();
    every(1000, fn, c.signal);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    c.abort();
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("poll: never overlaps, survives a refused read, stops on false, and ends with the signal", async () => {
    const c = new AbortController();
    const ticks: string[] = [];
    let n = 0;
    poll(
      1000,
      async () => {
        n += 1;
        ticks.push(`start${n}`);
        await new Promise((r) => setTimeout(r, 500)); // a slow read
        ticks.push(`end${n}`);
        if (n === 2) {
          throw Object.assign(new Error("refused"), { name: "ApiError" }); // what api() throws on a non-2xx
        }
        if (n === 4) {
          return false;
        }
      },
      c.signal,
    );
    await vi.advanceTimersByTimeAsync(1000 + 500); // tick 1
    await vi.advanceTimersByTimeAsync(1000 + 500); // tick 2 fails
    await vi.advanceTimersByTimeAsync(1000 + 500); // tick 3, after the failure
    expect(ticks).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
    await vi.advanceTimersByTimeAsync(1000 + 500); // tick 4 answers false
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(4);
    const d = new AbortController();
    let m = 0;
    poll(
      1000,
      async () => {
        m += 1;
      },
      d.signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(m).toBe(1);
    d.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(m).toBe(1);
  });

  it("poll: reports a tick that fails for any other reason, and keeps going", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const c = new AbortController();
    let n = 0;
    poll(
      1000,
      async () => {
        n += 1;
        if (n === 1) {
          throw new Error("a paint bug");
        }
      },
      c.signal,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ message: "a paint bug" });
    expect(n).toBe(2); // the poll went on
    c.abort();
    vi.unstubAllGlobals();
  });

  it("onAbort: runs on abort, or at once for a signal already aborted", () => {
    const c = new AbortController();
    const fn = vi.fn();
    onAbort(c.signal, fn);
    expect(fn).not.toHaveBeenCalled();
    c.abort();
    expect(fn).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    onAbort(c.signal, late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
