import { describe, expect, it } from "vitest";
import { carryOffset } from "./caret";

describe("carryOffset", () => {
  const before = "# Owls\n\nHoot. They fly at night.";

  it("keeps an offset before the change where it was", () => {
    const after = "# Owls\n\nHoot. They hunt at night.";
    expect(carryOffset(before, after, 3)).toBe(3);
  });

  it("moves an offset after the change with the text that follows it", () => {
    const after = "# Barn owls\n\nHoot. They fly at night.";
    const at = before.indexOf("night");
    expect(carryOffset(before, after, at)).toBe(after.indexOf("night"));
  });

  it("puts an offset inside the change at the change's end", () => {
    const after = "# Owls\n\nHoot. They glide at night.";
    const at = before.indexOf("fly") + 1;
    expect(carryOffset(before, after, at)).toBe(after.indexOf(" at night"));
  });

  it("stays inside a shorter text", () => {
    expect(carryOffset(before, "", before.length)).toBe(0);
    expect(carryOffset(before, "# Owls", before.length)).toBe(6);
  });

  it("leaves an unchanged text's offsets alone", () => {
    expect(carryOffset(before, before, 10)).toBe(10);
  });

  it("never lands inside a character written as two units, when the change ends or starts on one", () => {
    // 😀 is D83D DE00 and 🨀 is D83E DE00: the same second unit.
    const before = "abX\u{1F600}";
    const after = "abYZ\u{1FA00}";
    expect(carryOffset(before, after, 3)).toBe(after.length);
    // 😀 and 😃 (D83D DE03) share their first unit instead.
    expect(carryOffset("a\u{1F600}b", "a\u{1F603}b", 3)).toBe(3);
    expect(carryOffset("a\u{1F600}b", "a\u{1F603}cb", 1)).toBe(1);
  });
});
