import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const BASE = "https://kestrel.test";

describe("GET /api/version", () => {
  it("requires auth (401 without a token)", async () => {
    const res = await SELF.fetch(`${BASE}/api/version`);
    expect(res.status).toBe(401);
  });

  it("reports the running build to an authed client", async () => {
    const res = await SELF.fetch(`${BASE}/api/version`, { headers: await adminAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      sha: string;
      tag: string;
      buildTime: string;
      repoUrl: string;
      commitUrl: string;
      tagUrl: string;
    };

    // Shape + types, not exact values: sha, tag and buildTime vary by build.
    for (const k of [
      "version",
      "sha",
      "tag",
      "buildTime",
      "repoUrl",
      "commitUrl",
      "tagUrl",
    ] as const) {
      expect(typeof body[k]).toBe("string");
    }
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/); // semver-shaped
    expect(body.buildTime).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    // A browsable https URL (or "" when package.json names no repository) — the shape,
    // not this repo's owner, so a fork's suite stays green whatever it points at.
    expect(body.repoUrl === "" || /^https:\/\/[^/\s]+\/\S+[^/]$/.test(body.repoUrl)).toBe(true);

    // Derived links (src/build.ts) are built from the same fields, so assert the
    // relationship rather than a frozen string — stable across version/sha bumps. The
    // release link exists only when this build sits on its own version tag.
    if (body.sha !== "dev") {
      expect(body.commitUrl).toBe(`${body.repoUrl}/commit/${body.sha}`);
    }
    if (body.tag === `v${body.version}`) {
      expect(body.tagUrl).toBe(`${body.repoUrl}/releases/tag/${body.tag}`);
    } else {
      expect(body.tagUrl).toBe("");
    }
  });
});
