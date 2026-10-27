import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_LEAD_MS,
  formatLead,
  isSelfThrottled,
  isSendOwnHalt,
  MIN_LEAD_CEILING_MS,
  MIN_LEAD_FLOOR_MS,
  refusalAdvice,
  refusedMessage,
  SELF_THROTTLE_HALTS,
  tooSoonMessage,
  unavailableMessage,
} from "./sends";

describe("a refusal's advice", () => {
  // Each cause names its own fix, checked against AWS's docs, and who makes it (SPEC §12).
  it.each([
    [
      "credentials",
      ["SES access key", "ses:SendTemplatedEmail", "ses:SendBulkTemplatedEmail"],
      "whoever runs the deployment",
    ],
    ["opt_in", ["enables SES for the account"], "whoever runs the deployment"],
    ["configuration", ["SES_CONFIGURATION_SET", "creates the set"], "whoever runs the deployment"],
    ["sending_pool", ["dedicated IP pool", "sending options"], "whoever runs the deployment"],
    ["unsupported", ["AWS_REGION", "updates Kestrel"], "whoever runs the deployment"],
    [
      "sender",
      ["verifies the From address, or its domain", "AWS_REGION"],
      "whoever runs the deployment",
    ],
    [
      "mail_from",
      ["MAIL FROM domain", "MX record", "Behavior on MX failure"],
      "whoever runs the deployment",
    ],
    [
      "sandbox",
      ["sandbox", "requests production access", "verify the reader’s address"],
      "whoever runs the deployment",
    ],
    [
      "quota",
      ["In the sandbox (200 a day)", "requests production access", "Service Quotas"],
      "whoever runs the deployment",
    ],
    ["suspended", ["only AWS can lift it", "AWS Support"], "whoever runs the deployment"],
    [
      "paused",
      ["under review", "put-account-sending-attributes --sending-enabled"],
      "whoever runs the deployment",
    ],
    [
      "set_paused",
      ["SES_CONFIGURATION_SET", "put-configuration-set-sending-options --sending-enabled"],
      "whoever runs the deployment",
    ],
    [
      "content",
      ["can’t change once its send has started", "AWS Support"],
      "whoever runs the deployment",
    ],
    [
      "invalid_request",
      ["remove that subscriber", "skips anyone no longer on the list"],
      "remove that subscriber",
    ],
  ] as const)("names the fix for %s and who makes it", (cause, fixes, who) => {
    const advice = refusalAdvice(cause);
    for (const fix of fixes) {
      expect(advice).toContain(fix);
    }
    expect(advice.toLowerCase()).toContain(who);
  });

  it("is written with typographic apostrophes, whatever the cause", () => {
    for (const cause of [
      "credentials",
      "opt_in",
      "configuration",
      "sending_pool",
      "unsupported",
      "sender",
      "mail_from",
      "sandbox",
      "quota",
      "suspended",
      "paused",
      "set_paused",
      "content",
      "invalid_request",
      "not_connected",
      null,
    ] as const) {
      expect(refusalAdvice(cause)).not.toContain("'");
    }
  });
});

describe("a refused send's words", () => {
  it("claims no one unsent only because of this refusal, so it stays true beside earlier unsent readers (SPEC §12)", () => {
    for (const cause of ["credentials", "content", "not_connected"] as const) {
      expect(refusedMessage(cause, "words")).toContain(
        "No one has been marked unsent because of this",
      );
    }
  });

  it("says the account for an account's refusal, and this send for its own email's", () => {
    expect(refusedMessage("sandbox", "ses 400 MessageRejected: no")).toBe(
      `The provider is refusing the account: ses 400 MessageRejected: no. ${refusalAdvice("sandbox")} No one has been marked unsent because of this, and the send resumes on its own at its next retry once the account is fixed.`,
    );
    expect(refusedMessage("content", "ses 413")).toMatch(
      /^The provider is refusing this send: ses 413\. /,
    );
    expect(isSendOwnHalt("content")).toBe(true);
    expect(isSendOwnHalt("invalid_request")).toBe(true);
    expect(isSendOwnHalt("sandbox")).toBe(false);
    expect(isSendOwnHalt(null)).toBe(false);
  });
});

describe("a rate limit the deployment causes itself", () => {
  const halt = (retries: number, cause: "rate_limit" | "outage" = "rate_limit") => ({
    halt_reason: "unavailable" as const,
    halt_cause: cause,
    halt_retries: retries,
    halt_error: "ses 429 TooManyRequestsException: Maximum sending rate exceeded.",
  });

  it("is told apart once it has refused the first request of several retries in a row (SPEC §12)", () => {
    expect(isSelfThrottled(halt(SELF_THROTTLE_HALTS - 1))).toBe(false);
    expect(isSelfThrottled(halt(SELF_THROTTLE_HALTS))).toBe(true);
    expect(isSelfThrottled(halt(SELF_THROTTLE_HALTS, "outage"))).toBe(false);
  });

  it("points whoever runs the deployment at SES_MAX_SEND_RATE, and a burst at nothing to do", () => {
    expect(unavailableMessage(halt(SELF_THROTTLE_HALTS))).toContain(
      "Whoever runs the deployment sets SES_MAX_SEND_RATE to the maximum send rate on the SES console’s account dashboard",
    );
    expect(unavailableMessage(halt(1))).toBe(
      "The provider is unavailable: ses 429 TooManyRequestsException: Maximum sending rate exceeded. The send retries on its own, spaced out the longer this lasts, and no one has been marked unsent because of this.",
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

  it("refuses a time inside it in the publisher's words", () => {
    expect(tooSoonMessage(DEFAULT_MIN_LEAD_MS)).toBe(
      "Pick a time at least 5 minutes from now, so there’s time to cancel.",
    );
    expect(tooSoonMessage(90_000)).toBe(
      "Pick a time at least 90 seconds from now, so there’s time to cancel.",
    );
  });
});
