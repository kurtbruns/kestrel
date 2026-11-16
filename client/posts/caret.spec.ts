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
});
