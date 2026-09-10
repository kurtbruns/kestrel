import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The admin SPA moved from /admin/ to /dashboard/ (issue #82). Old bookmarks get a
// permanent, path- and query-preserving 301. This is admin→admin, so no §10 concern.
describe("legacy /admin → /dashboard redirect", () => {
  it("301s the bare /admin to /dashboard/", async () => {
    const res = await SELF.fetch("https://kestrel.test/admin", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location") ?? "", "https://kestrel.test").pathname).toBe(
      "/dashboard/",
    );
  });

  it("preserves the sub-path and query", async () => {
    const res = await SELF.fetch("https://kestrel.test/admin/app.js?v=abc123", {
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get("location") ?? "", "https://kestrel.test");
    expect(loc.pathname).toBe("/dashboard/app.js");
    expect(loc.search).toBe("?v=abc123");
  });

  it("does not touch a path that merely starts with the letters 'admin'", async () => {
    // /administrate is not /admin or /admin/* — it must fall through to the router.
    const res = await SELF.fetch("https://kestrel.test/administrate", { redirect: "manual" });
    expect(res.status).not.toBe(301);
  });
});
