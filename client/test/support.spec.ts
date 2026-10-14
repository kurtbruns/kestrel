import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDownloads } from "./support";

describe("captureDownloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets a plain anchor's click through, and keeps each object URL's own file", async () => {
    const saved = captureDownloads();
    // A plain link still clicks: its listener runs, so a spec can't lose a real click.
    const link = document.createElement("a");
    link.href = "#/subscribers";
    const clicked = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener("click", clicked);
    link.click();
    expect(clicked).toHaveBeenCalledOnce();
    // Two files made before either is clicked: each name is saved with its own contents.
    const first = URL.createObjectURL(new Blob(["first"], { type: "text/csv" }));
    const second = URL.createObjectURL(new Blob(["second"], { type: "text/csv" }));
    expect(first).not.toBe(second);
    for (const [href, name] of [
      [second, "second.csv"],
      [first, "first.csv"],
    ]) {
      const a = document.createElement("a");
      a.href = href ?? "";
      a.download = name ?? "";
      a.click();
    }
    expect(saved.map((f) => f.name)).toEqual(["second.csv", "first.csv"]);
    expect(await Promise.all(saved.map((f) => f.blob.text()))).toEqual(["second", "first"]);
  });
});
