import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import { adminAuth } from "./support/auth";

// The admin line is a path prefix (SPEC §11): every admin route sits under /api/, and no
// public or webhook route does, so an Access application that covers `dashboard` and `api`
// covers the whole admin surface, a new admin route included. The dev routes are the one
// exception (the public token bootstrap), and a deployed instance never registers them.

const API = "/api/";
const AUTH = await adminAuth();
const base = "https://kestrel.test";

function routes(devMode: boolean) {
  return createRouter({ archiveBasePath: "/archive", devMode, minLeadMs: 60_000 }).routes.map(
    (r) => r.def,
  );
}

describe("the admin surface is everything under /api/ (SPEC §11)", () => {
  it("puts every admin route under /api/, deployed and in dev", () => {
    for (const devMode of [false, true]) {
      const outside = routes(devMode)
        .filter((d) => d.access === "admin" && !d.path.startsWith(API))
        .map((d) => `${d.method} ${d.path}`);
      expect(outside).toEqual([]);
    }
  });

  it("puts no public or webhook route under /api/ once deployed", () => {
    const inside = routes(false)
      .filter((d) => d.access !== "admin" && d.path.startsWith(API))
      .map((d) => `${d.method} ${d.path}`);
    expect(inside).toEqual([]);
  });

  it("allows a public route under /api/ only among the dev routes", () => {
    const inside = routes(true)
      .filter((d) => d.access !== "admin" && d.path.startsWith(API))
      .map((d) => d.path);
    expect(inside.length).toBeGreaterThan(0);
    for (const path of inside) {
      expect(path.startsWith("/api/dev/")).toBe(true);
    }
  });

  it("answers the old top-level admin paths with a plain 404, even signed in", async () => {
    for (const path of ["/posts", "/sends", "/sends/feed", "/subscribers", "/suppressions"]) {
      const res = await SELF.fetch(`${base}${path}`, { headers: AUTH });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});
