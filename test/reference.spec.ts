import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import { requireAuth } from "../src/auth/middleware";
import { buildReference } from "../src/reference";
import { type RouteDef, Router } from "../src/router";
import { adminAuth } from "./support/auth";

// The point of the manifest: the reference IS the registration. These tests pin
// that it can't drift — every live route is listed, its documented tier is the
// tier that actually gates it, and a newly registered route shows up for free.

describe("API reference is generated from the route registration", () => {
  const router = createRouter("/archive");
  const defs = router.routes.map((r) => r.def);

  it("lists every registered route, each tagged with its own tier", () => {
    const groups = buildReference(defs);
    const listed = groups.flatMap((g) =>
      g.routes.map((r) => ({ key: `${r.method} ${r.path}`, access: r.access })),
    );
    // Same routes as the router, no more and no fewer.
    expect(new Set(listed.map((l) => l.key))).toEqual(
      new Set(defs.map((d) => `${d.method} ${d.path}`)),
    );
    expect(listed.length).toBe(defs.length);
    // Every route lands in the group matching its declared access.
    for (const g of groups) {
      for (const r of g.routes) {
        expect(r.access).toBe(g.access);
      }
    }
  });

  it("groups admin, public, and webhook tiers (mirroring app.ts)", () => {
    const groups = buildReference(defs);
    expect(groups.map((g) => g.access)).toEqual(["admin", "public", "webhook"]);
  });

  it("documents the declared tier as the tier that actually gates the route", () => {
    // `access` DRIVES the gate: admin ⇒ requireAuth present; public/webhook ⇒ absent.
    for (const route of router.routes) {
      expect(route.middleware.includes(requireAuth)).toBe(route.def.access === "admin");
    }
  });

  it("is self-describing: the reference endpoint appears in its own listing", () => {
    expect(defs.some((d) => d.method === "GET" && d.path === "/api/reference")).toBe(true);
  });

  it("carries documented query params through for list routes (filter/sort/pagination)", () => {
    const groups = buildReference(defs);
    const listRoute = groups
      .flatMap((g) => g.routes)
      .find((r) => r.method === "GET" && r.path === "/subscribers");
    const names = listRoute?.query?.map((q) => q.name) ?? [];
    // The list contract — filter + sort + pagination — is documented from the registration.
    expect(names).toEqual(
      expect.arrayContaining(["status", "suppressed", "sort", "limit", "offset"]),
    );
  });

  it("a newly registered route appears in the reference with no separate doc to touch", () => {
    const r = new Router();
    const added: RouteDef = {
      method: "POST",
      path: "/demo/thing",
      access: "admin",
      summary: "A freshly registered admin route.",
      handler: () => new Response("ok"),
    };
    r.register(added);
    r.register({
      method: "GET",
      path: "/demo/public",
      access: "public",
      summary: "A freshly registered public route.",
      handler: () => new Response("ok"),
    });
    const groups = buildReference(r.routes.map((x) => x.def));
    const admin = groups.find((g) => g.access === "admin");
    const pub = groups.find((g) => g.access === "public");
    expect(admin?.routes.some((x) => x.path === "/demo/thing")).toBe(true);
    expect(pub?.routes.some((x) => x.path === "/demo/public")).toBe(true);
    // And the declared admin tier is backed by the real gate.
    const addedRoute = r.routes.find((x) => x.def.path === "/demo/thing");
    expect(addedRoute?.middleware.includes(requireAuth)).toBe(true);
  });
});

describe("/api/reference is served like the rest of the authed admin surface", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/reference");
    expect(res.status).toBe(401);
  });

  it("returns the manifest as JSON when authed, listing real routes (the SPA renders it)", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/reference", {
      headers: await adminAuth(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      groups: { access: string; routes: { method: string; path: string; access: string }[] }[];
    };
    const routes = body.groups.flatMap((g) => g.routes);
    // Real routes + methods + tiers survive to the payload.
    expect(routes.some((r) => r.path === "/posts")).toBe(true);
    expect(routes.some((r) => r.path === "/webhooks/ses" && r.access === "webhook")).toBe(true);
    expect(routes.some((r) => r.method === "POST")).toBe(true);
    // A hand-authored example made it through (the create-post request body).
    expect(JSON.stringify(body)).toContain("Hello, world");
  });
});
