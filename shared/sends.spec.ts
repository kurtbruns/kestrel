import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_LEAD_MS,
  formatLead,
  MIN_LEAD_CEILING_MS,
  MIN_LEAD_FLOOR_MS,
  refusalAdvice,
} from "./sends";

describe("a refusal's advice", () => {
  it("sends a configuration set SES can't find to the setting that names it, not to the access key (SPEC §12)", () => {
    expect(refusalAdvice("configuration")).toBe(
      "Check that the SES_CONFIGURATION_SET secret names a configuration set in your SES region, or create the set in the SES console.",
    );
  });
});

describe("the minimum lead", () => {
  it("defaults to five minutes, never goes below one sweep tick, and never above a day", () => {
    expect(DEFAULT_MIN_LEAD_MS).toBe(5 * 60 * 1000);
    expect(MIN_LEAD_FLOOR_MS).toBe(60 * 1000);
    expect(MIN_LEAD_CEILING_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is worded in whole minutes when it is one, in seconds otherwise", () => {
    expect(formatLead(DEFAULT_MIN_LEAD_MS)).toBe("5 minutes");
    expect(formatLead(MIN_LEAD_FLOOR_MS)).toBe("1 minute");
    expect(formatLead(90_000)).toBe("90 seconds");
    expect(formatLead(60 * 60 * 1000)).toBe("60 minutes");
  });
});
