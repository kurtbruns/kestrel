import { describe, expect, it } from "vitest";
import { headingAnchor, headingAnchors } from "./docs";

describe("headingAnchor", () => {
  it("derives a heading's anchor the way GitHub does", () => {
    expect(headingAnchor("7. Read the logs")).toBe("7-read-the-logs");
    expect(headingAnchor("3. Fill in wrangler.jsonc")).toBe("3-fill-in-wranglerjsonc");
    expect(headingAnchor("Before you begin")).toBe("before-you-begin");
  });
});

describe("headingAnchors", () => {
  it("gives a repeated heading GitHub's -1, -2 in document order", () => {
    expect(headingAnchors(["Check it", "Setup", "Check it", "Check it!"])).toEqual([
      "check-it",
      "setup",
      "check-it-1",
      "check-it-2",
    ]);
  });
});
