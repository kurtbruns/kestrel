import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH, base } from "./support/http";

describe("GET /api/version", () => {
  it("requires auth (401 without a token)", async () => {
    const res = await SELF.fetch(`${base}/api/version`);
    expect(res.status).toBe(401);
  });

  it("reports the running build to an authed client", async () => {
    const res = await SELF.fetch(`${base}/api/version`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      sha: string;
      tag: string;
      build_time: string;
      repo_url: string;
      commit_url: string;
      tag_url: string;
    };

    // Shape + types, not exact values: sha, tag and build_time vary by build.
    for (const k of [
      "version",
      "sha",
      "tag",
      "build_time",
      "repo_url",
      "commit_url",
      "tag_url",
    ] as const) {
      expect(typeof body[k]).toBe("string");
    }
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/); // semver-shaped
    expect(body.build_time).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    // A browsable https URL (or "" when package.json names no repository) — the shape,
    // not this repo's owner, so a fork's suite stays green whatever it points at.
    expect(body.repo_url === "" || /^https:\/\/[^/\s]+\/\S+[^/]$/.test(body.repo_url)).toBe(true);

    // Derived links (src/build.ts) are built from the same fields, so assert the
    // relationship rather than a frozen string — stable across version/sha bumps. The
    // release link exists only when this build sits on its own version tag.
    if (body.sha !== "dev") {
      expect(body.commit_url).toBe(`${body.repo_url}/commit/${body.sha}`);
    }
    if (body.tag === `v${body.version}`) {
      expect(body.tag_url).toBe(`${body.repo_url}/releases/tag/${body.tag}`);
    } else {
      expect(body.tag_url).toBe("");
    }
  });
});
