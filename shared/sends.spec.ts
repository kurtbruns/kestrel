import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_LEAD_MS,
  formatLead,
  MIN_LEAD_CEILING_MS,
  MIN_LEAD_FLOOR_MS,
  refusalAdvice,
  tooSoonMessage,
} from "./sends";

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

  it("refuses a time inside it in the publisher's words", () => {
    expect(tooSoonMessage(DEFAULT_MIN_LEAD_MS)).toBe(
      "Pick a time at least 5 minutes from now, so there’s time to cancel.",
    );
    expect(tooSoonMessage(90_000)).toBe(
      "Pick a time at least 90 seconds from now, so there’s time to cancel.",
    );
  });
});

describe("the advice for a provider refusing the account", () => {
  it("is written with typographic apostrophes, whatever the cause", () => {
    for (const cause of [
      "credentials",
      "sender",
      "quota",
      "suspended",
      "not_connected",
      null,
    ] as const) {
      expect(refusalAdvice(cause)).not.toContain("'");
    }
    expect(refusalAdvice("quota")).toBe(
      "Wait for SES’s 24-hour quota to free up, or ask AWS to raise it in the Service Quotas console.",
    );
  });
});
