import { describe, expect, it } from "vitest";
import { ERASED_PREFIX, isErasedPlaceholder } from "./subscribers";

describe("isErasedPlaceholder (SPEC §7)", () => {
  it("tells an erasure's placeholder from an address", () => {
    expect(isErasedPlaceholder(`${ERASED_PREFIX}0f3a9c2e7b1d4e8f`)).toBe(true);
    expect(isErasedPlaceholder("ada@example.com")).toBe(false);
    expect(isErasedPlaceholder("erased@example.com")).toBe(false);
  });
});
