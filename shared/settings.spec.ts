import { describe, expect, it } from "vitest";
import { isBuiltInText, missedAddresses } from "./settings";

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

describe("whether a saved template is the built-in one's text (SPEC §9)", () => {
  const builtIn = "<style>p{}</style>\n<p>{{ .Post.Body }}</p>\n";
  it("is, whatever its line endings and the whitespace at either end", () => {
    expect(isBuiltInText(builtIn, builtIn)).toBe(true);
    expect(isBuiltInText(`  ${builtIn.replace(/\n/g, "\r\n")}\n\n`, builtIn)).toBe(true);
  });
  it("isn't, for any other difference, inner whitespace included", () => {
    expect(isBuiltInText(builtIn.replace("p{}", "p{ }"), builtIn)).toBe(false);
    expect(isBuiltInText("", builtIn)).toBe(false);
  });
});
