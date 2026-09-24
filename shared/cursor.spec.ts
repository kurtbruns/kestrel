import { describe, expect, it } from "vitest";
import { decodeSendCursor, earlierCursor, encodeSendCursor } from "./cursor";

describe("earlierCursor", () => {
  it("is at or before both, in sequence and in time", () => {
    const a = encodeSendCursor({ seq: 10, at: 5_000 });
    const b = encodeSendCursor({ seq: 7, at: 9_000 });
    expect(decodeSendCursor(earlierCursor(a, b))).toEqual({ seq: 7, at: 5_000 });
    expect(earlierCursor(a, a)).toBe(a);
  });

  it("lets one that does not parse give way to the other", () => {
    const a = encodeSendCursor({ seq: 3, at: 1_000 });
    expect(earlierCursor("junk", a)).toBe(a);
    expect(earlierCursor(a, "junk")).toBe(a);
  });
});
