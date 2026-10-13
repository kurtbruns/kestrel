import { describe, expect, it } from "vitest";
import { headingAnchor } from "./docs";

describe("headingAnchor", () => {
  it("derives a heading's anchor the way GitHub does", () => {
    expect(headingAnchor("7. Read the logs")).toBe("7-read-the-logs");
    expect(headingAnchor("3. Fill in wrangler.jsonc")).toBe("3-fill-in-wranglerjsonc");
    expect(headingAnchor("Before you begin")).toBe("before-you-begin");
  });
});
