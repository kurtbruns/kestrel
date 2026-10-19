import { describe, expect, it } from "vitest";
import { whoActed } from "./who_acted";

describe("whoActed (SPEC §11, Who acted)", () => {
  it("shows a person in the editor alone", () => {
    expect(whoActed("you@example.com", "editor")).toBe("you@example.com");
  });

  it("names the client a person came through by its own name, or as it named itself", () => {
    expect(whoActed("you@example.com", "claude-code")).toBe("you@example.com via Claude Code");
    expect(whoActed("you@example.com", "my-script")).toBe("you@example.com via my-script");
  });

  it("shows a person whose client named nothing as through the API", () => {
    expect(whoActed("you@example.com", null)).toBe("you@example.com via the API");
  });

  it("shows a service token as automation whatever the client, and nobody as nothing", () => {
    expect(whoActed("service", null)).toBe("a service token");
    expect(whoActed("service", "claude-code")).toBe("a service token");
    expect(whoActed(null, "editor")).toBeNull();
  });
});
