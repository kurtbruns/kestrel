import { describe, expect, it } from "vitest";
import { archivePostUrl, unlistedPostUrl } from "./archive_url";

describe("archivePostUrl", () => {
  it("joins origin, base path, and slug", () => {
    expect(archivePostUrl("https://example.com", "/archive", "welcome")).toBe(
      "https://example.com/archive/welcome",
    );
  });

  it("serves from the origin root when the base path is empty", () => {
    expect(archivePostUrl("http://localhost:8787", "", "welcome")).toBe(
      "http://localhost:8787/welcome",
    );
  });
});

describe("unlistedPostUrl", () => {
  it("sits on the app's own origin, whatever the archive's (SPEC §5)", () => {
    expect(unlistedPostUrl("https://newsletter.example.com", "0f3a")).toBe(
      "https://newsletter.example.com/email/0f3a",
    );
  });
});
