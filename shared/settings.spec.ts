import { describe, expect, it } from "vitest";
import { missedAddresses } from "./settings";

describe("the words for addresses a notification missed (SPEC §8)", () => {
  it("are the channel's alone with one address, and led by each address with several", () => {
    const miss = { email: "me@example.com", error: "not verified" };
    expect(missedAddresses(["me@example.com"], [miss])).toBe("not verified");
    expect(
      missedAddresses(
        ["me@example.com", "ops@example.com"],
        [miss, { email: "ops@example.com", error: "refused" }],
      ),
    ).toBe("me@example.com: not verified; ops@example.com: refused");
    expect(missedAddresses(["me@example.com", "ops@example.com"], [miss])).toBe(
      "me@example.com: not verified",
    );
  });
});
