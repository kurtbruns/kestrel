import { describe, expect, it } from "vitest";
import { buildCommitUrl, buildReleaseUrl } from "./build";

const SOURCE = "https://github.com/x/kestrel";

describe("buildCommitUrl", () => {
  it("links a commit on the build's own source (SPEC §9)", () => {
    expect(buildCommitUrl({ sha: "abc1234", source_url: SOURCE })).toBe(`${SOURCE}/commit/abc1234`);
  });

  it("is empty for a dev SHA, which names no commit", () => {
    expect(buildCommitUrl({ sha: "dev", source_url: SOURCE })).toBe("");
  });

  it("is empty with no source", () => {
    expect(buildCommitUrl({ sha: "abc1234", source_url: "" })).toBe("");
  });
});

describe("buildReleaseUrl", () => {
  it("links the release a build sits exactly on", () => {
    expect(buildReleaseUrl({ version: "1.2.0", tag: "v1.2.0", source_url: SOURCE })).toBe(
      `${SOURCE}/releases/tag/v1.2.0`,
    );
  });

  it("is empty for a build between releases", () => {
    expect(buildReleaseUrl({ version: "1.2.0", tag: "", source_url: SOURCE })).toBe("");
  });

  it("is empty when the tag isn't this version's", () => {
    expect(buildReleaseUrl({ version: "1.2.0", tag: "v1.1.0", source_url: SOURCE })).toBe("");
    expect(buildReleaseUrl({ version: "1.2.0", tag: "nightly", source_url: SOURCE })).toBe("");
  });

  it("is empty with no source", () => {
    expect(buildReleaseUrl({ version: "1.2.0", tag: "v1.2.0", source_url: "" })).toBe("");
  });
});
