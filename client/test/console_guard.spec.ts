// The client's console guard (console_guard.ts): what it counts as an error line, what an
// allowance lets through, and that a preview frame mounts without writing one, which is what
// holds happy-dom's frame loading on in vitest.config.ts. Each test reads the guard's state
// and clears it before the guard's own afterEach runs, so a line written here on purpose
// doesn't fail the test that proves it would.

import { afterEach, describe, expect, it } from "vitest";
import { consoleGuard } from "./console_guard";
import { allowConsoleErrors, settle } from "./support";

afterEach(() => {
  consoleGuard.reset();
  for (const frame of document.querySelectorAll("body > iframe")) {
    frame.remove();
  }
});

describe("console guard", () => {
  it("counts a view's console.error and console.warn", () => {
    console.error("view failed");
    console.warn("view unsure");
    expect(consoleGuard.problems()).toEqual(["view failed", "view unsure"]);
  });

  it("counts a write that bypasses Vitest's console, as happy-dom's own messages do", () => {
    // An empty chunk prints nothing, so proving the guard sees the stream adds no line to the run.
    (
      globalThis as unknown as { process: { stderr: { write(s: string): boolean } } }
    ).process.stderr.write("");
    expect(consoleGuard.problems()).toEqual([""]);
  });

  it("lets through only the lines a test allows, by substring or pattern", () => {
    allowConsoleErrors("expected failure", /^known \d+$/);
    console.error("an expected failure, on purpose");
    console.error("known 42");
    console.error("something else");
    expect(consoleGuard.problems()).toEqual(["something else"]);
  });

  it("mounts a frame with no src without writing an error line", async () => {
    document.body.insertAdjacentHTML("beforeend", `<iframe title="preview"></iframe>`);
    const frame = document.querySelector<HTMLIFrameElement>("body > iframe");
    frame?.setAttribute("srcdoc", "<p>sample</p>");
    await settle();
    expect(frame?.contentDocument?.body?.textContent).toBe("sample");
    expect(consoleGuard.problems()).toEqual([]);
  });
});
