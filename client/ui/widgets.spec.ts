import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShell } from "../test/support";
import { $ } from "./dom";
import { toast } from "./widgets";

// What the reader sees: the toasts still showing, oldest first, leaving ones excluded.
const showing = (): string[] =>
  [...$("#toasts").querySelectorAll(".toast:not(.leaving)")].map((t) => t.textContent ?? "");

describe("toast (DESIGN §2)", () => {
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fades after its time and then leaves the region", () => {
    toast("Saved");
    expect(showing()).toEqual(["Saved"]);
    vi.advanceTimersByTime(3600);
    expect(showing()).toEqual([]);
    expect($("#toasts").children.length).toBe(1); // still collapsing
    vi.advanceTimersByTime(300);
    expect($("#toasts").children.length).toBe(0);
  });

  it("restarts a message already showing instead of stacking a second copy", () => {
    toast("Copied");
    vi.advanceTimersByTime(3000);
    toast("Copied");
    expect(showing()).toEqual(["Copied"]);
    vi.advanceTimersByTime(3000); // past the first one's time, inside the restart's
    expect(showing()).toEqual(["Copied"]);
    vi.advanceTimersByTime(600);
    expect(showing()).toEqual([]);
  });

  it("shows at most three, the oldest leaving early for a new one", () => {
    for (const m of ["One", "Two", "Three", "Four", "Five"]) {
      toast(m);
    }
    expect(showing()).toEqual(["Three", "Four", "Five"]);
    vi.advanceTimersByTime(300);
    expect($("#toasts").children.length).toBe(3);
  });
});
