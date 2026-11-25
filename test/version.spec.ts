import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH, base } from "./support/http";

describe("GET /api/version", () => {
  it("requires auth (401 without a token)", async () => {
    const res = await SELF.fetch(`${base}/api/version`);
    expect(res.status).toBe(401);
  });

  it("reports the release and commit the instance runs to an authed client (SPEC §9)", async () => {
    const res = await SELF.fetch(`${base}/api/version`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      sha: string;
      tag: string;
      commit_time: string;
      source_url: string;
    };

    // Exactly these fields: the pages a build links to are derived by the client
    // (shared/build.ts), never sent.
    expect(Object.keys(body).sort()).toEqual([
      "commit_time",
      "sha",
      "source_url",
      "tag",
      "version",
    ]);
    // Shape + types, not exact values: sha, tag and commit_time vary by build.
    for (const k of ["version", "sha", "tag", "commit_time", "source_url"] as const) {
      expect(typeof body[k]).toBe("string");
    }
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/); // semver-shaped
    // The built commit's time as ISO 8601 with its offset, or "" when built without git.
    expect(
      body.commit_time === "" ||
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(body.commit_time),
    ).toBe(true);
    // A browsable https URL (or "" when package.json names no repository) — the shape,
    // not this repo's owner, so a fork's suite stays green whatever it points at.
    expect(body.source_url === "" || /^https:\/\/[^/\s]+\/\S+[^/]$/.test(body.source_url)).toBe(
      true,
    );
  });
});
