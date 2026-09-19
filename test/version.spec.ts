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
      buildTime: string;
      repoUrl: string;
      commitUrl: string;
      tagUrl: string;
    };

    // Shape + types, not exact values: sha and buildTime vary by build.
    for (const k of ["version", "sha", "buildTime", "repoUrl", "commitUrl", "tagUrl"] as const) {
      expect(typeof body[k]).toBe("string");
    }
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/); // semver-shaped
    expect(body.buildTime).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(body.repoUrl).toContain("github.com/kurtbruns/kestrel");

    // Derived links (src/build.ts) are built from the same fields, so assert the
    // relationship rather than a frozen string — stable across version/sha bumps.
    expect(body.tagUrl).toBe(`${body.repoUrl}/releases/tag/v${body.version}`);
    if (body.sha !== "dev") {
      expect(body.commitUrl).toBe(`${body.repoUrl}/commit/${body.sha}`);
    }
  });
});
