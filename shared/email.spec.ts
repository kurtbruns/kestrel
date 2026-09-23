import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Reader@Example.COM \n")).toBe("reader@example.com");
  });
});

describe("isValidEmail", () => {
  it("accepts a plain address, and a plus or subdomain one", () => {
    expect(isValidEmail("reader@example.com")).toBe(true);
    expect(isValidEmail("reader+owls@mail.example.co.uk")).toBe(true);
  });

  it("refuses what is not an address", () => {
    for (const bad of [
      "",
      "reader",
      "reader@",
      "@example.com",
      "reader@example",
      "a b@example.com",
      "a@b@example.com",
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});
