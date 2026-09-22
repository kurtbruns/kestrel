import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "./autosave";

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const timers = { idleMs: 100, maxMs: 500 };

  it("saves after the idle pause, once", () => {
    const save = vi.fn();
    const a = createAutosave(save, timers);
    a.touch();
    expect(a.pending).toBe(true);
    vi.advanceTimersByTime(99);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps deferring while edits keep coming, until the hard cap", () => {
    const save = vi.fn();
    const a = createAutosave(save, timers);
    for (let t = 0; t < 500; t += 50) {
      a.touch();
      vi.advanceTimersByTime(50);
    }
    // 500 ms of continuous typing: the idle timer never fired, the cap did, exactly once.
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(false);
  });

  it("starts a fresh cap after a save, so the next burst gets its own", () => {
    const save = vi.fn();
    const a = createAutosave(save, timers);
    a.touch();
    vi.advanceTimersByTime(100); // idle fires
    a.touch();
    vi.advanceTimersByTime(100); // idle fires again: the cap was cleared by the first save
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("cancel forgets both timers", () => {
    const save = vi.fn();
    const a = createAutosave(save, timers);
    a.touch();
    a.cancel();
    expect(a.pending).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
