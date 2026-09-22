import { describe, expect, it } from "vitest";
import { archivePostUrl } from "./archive_url";

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
