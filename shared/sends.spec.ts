import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_LEAD_MS, formatLead, MIN_LEAD_FLOOR_MS } from "./sends";

describe("the minimum lead", () => {
  it("defaults to five minutes and never goes below one sweep tick", () => {
    expect(DEFAULT_MIN_LEAD_MS).toBe(5 * 60 * 1000);
    expect(MIN_LEAD_FLOOR_MS).toBe(60 * 1000);
  });

  it("is worded in whole minutes when it is one, in seconds otherwise", () => {
    expect(formatLead(DEFAULT_MIN_LEAD_MS)).toBe("5 minutes");
    expect(formatLead(MIN_LEAD_FLOOR_MS)).toBe("1 minute");
    expect(formatLead(90_000)).toBe("90 seconds");
    expect(formatLead(60 * 60 * 1000)).toBe("60 minutes");
  });
});
