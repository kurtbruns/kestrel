import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("lowercases, strips diacritics, and joins runs of non-alphanumerics with one dash", () => {
    expect(slugify("The Hovering Hunter")).toBe("the-hovering-hunter");
    expect(slugify("Café — crème brûlée!")).toBe("cafe-creme-brulee");
    expect(slugify("  spaced   out  ")).toBe("spaced-out");
  });

  it("returns an empty slug when nothing usable remains", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!! ???")).toBe("");
  });

  it("caps at 80 characters without a trailing dash", () => {
    const long = `${"a".repeat(79)} b`;
    expect(slugify(long)).toBe("a".repeat(79));
    expect(slugify(long)).not.toMatch(/-$/);
  });
});
