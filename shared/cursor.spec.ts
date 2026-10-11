import { describe, expect, it } from "vitest";
import { decodeSendCursor, earlierCursor, encodeSendCursor } from "./cursor";

describe("the cursor format", () => {
  it("is `<seq>.<at>` in decimal, as the API reference documents it for every client", () => {
    expect(encodeSendCursor({ seq: 57, at: 1_768_467_610_000 })).toBe("57.1768467610000");
    expect(decodeSendCursor("57.1768467610000")).toEqual({ seq: 57, at: 1_768_467_610_000 });
    expect(decodeSendCursor("0.0")).toEqual({ seq: 0, at: 0 });
  });

  it("refuses anything else rather than guess at it", () => {
    for (const raw of [
      "",
      "57",
      "57.",
      ".1768467610000",
      "57.1768467610000.1",
      "57.5e3",
      "5.7.1",
      "-1.1000",
      "1.-1000",
      "1.5.1000",
      "0x1.1000",
      " 57.1000",
      "57.1000 ",
      "57,1000",
    ]) {
      expect(decodeSendCursor(raw), raw).toBeNull();
    }
  });

  it("refuses a number too large to be held exactly", () => {
    const unsafe = String(Number.MAX_SAFE_INTEGER + 1); // 9007199254740992
    expect(decodeSendCursor(`${Number.MAX_SAFE_INTEGER}.1`)).toEqual({
      seq: Number.MAX_SAFE_INTEGER,
      at: 1,
    });
    expect(decodeSendCursor(`${unsafe}.1`)).toBeNull();
    expect(decodeSendCursor(`1.${unsafe}`)).toBeNull();
    expect(decodeSendCursor(`1.${"9".repeat(400)}`)).toBeNull(); // Infinity, not a cursor
  });
});

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
