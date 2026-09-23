import { describe, expect, it } from "vitest";
import { invalidAddressesMessage, parseAddresses } from "./format";

describe("parseAddresses", () => {
  it("normalizes and dedupes the addresses, and keeps what isn't one, as typed", () => {
    expect(parseAddresses(" Me@Example.com, me@example.com\nTypo@gmail,,  , you@b.co ")).toEqual({
      valid: ["me@example.com", "you@b.co"],
      invalid: ["Typo@gmail"],
    });
  });

  it("reads empty input as nothing at all", () => {
    expect(parseAddresses("")).toEqual({ valid: [], invalid: [] });
    expect(parseAddresses(null)).toEqual({ valid: [], invalid: [] });
  });
});

describe("invalidAddressesMessage", () => {
  it("names the entries, or says nothing when there are none", () => {
    expect(invalidAddressesMessage([])).toBeNull();
    expect(invalidAddressesMessage(["typo@gmail"])).toBe("Not an email address: typo@gmail");
    expect(invalidAddressesMessage(["a", "b@c"])).toBe("Not email addresses: a, b@c");
  });
});
