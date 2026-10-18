// Strict at the door (API.md, principle 7): an admin route refuses a query parameter it
// doesn't declare, a query value outside the ones it declares, and a body field it doesn't
// declare, each a 400 naming the field, so a typo or a stale name is never a 200 that ignored
// it. Walked over every admin route on the manifest, so a new route is held to it too.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import { resetDatabase } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, PNG_1x1, readJson } from "./support/http";

beforeEach(async () => {
  await resetDatabase();
});

const adminRoutes = createRouter(getConfig(env as AppEnv))
  .routes.map((r) => r.def)
  .filter((d) => d.access === "admin");

/** A concrete path for a route's pattern: each `:param` a dummy that names nothing. */
function concrete(path: string): string {
  return path.replace(/:(\w+)(\([^)]*\))?/g, "x1").replace(/\{[^}]*\}\??/g, "");
}

async function expectRefusedNaming(res: Response, field: string, what: string) {
  const body = await readJson(res);
  expect(res.status, `${what}: ${JSON.stringify(body)}`).toBe(400);
  expect(body.field, what).toBe(field);
}

describe("an admin route refuses what its manifest entry doesn't declare", () => {
  it("has admin routes to walk", () => {
    expect(adminRoutes.length).toBeGreaterThan(30);
  });

  for (const def of adminRoutes) {
    const what = `${def.method} ${def.path}`;

    it(`${what}: an undeclared query parameter is a 400 naming it`, async () => {
      const res = await SELF.fetch(`${base}${concrete(def.path)}?bogus_param=1`, {
        method: def.method,
        headers: AUTH,
      });
      await expectRefusedNaming(res, "bogus_param", what);
    });

    for (const q of (def.query ?? []).filter((p) => p.values)) {
      it(`${what}: a ${q.name} outside its values is a 400 naming it`, async () => {
        const res = await SELF.fetch(`${base}${concrete(def.path)}?${q.name}=bogus_value`, {
          method: def.method,
          headers: AUTH,
        });
        await expectRefusedNaming(res, q.name, what);
      });
    }

    if (def.accepts?.includes("application/json")) {
      it(`${what}: an undeclared JSON body field is a 400 naming it`, async () => {
        const res = await SELF.fetch(`${base}${concrete(def.path)}`, {
          method: def.method,
          headers: JSON_AUTH,
          body: JSON.stringify({ bogus_field: 1 }),
        });
        await expectRefusedNaming(res, "bogus_field", what);
      });
    }

    if (def.accepts?.includes("multipart/form-data")) {
      it(`${what}: an undeclared form field is a 400 naming it`, async () => {
        const fd = new FormData();
        fd.append("bogus_field", "1");
        const res = await SELF.fetch(`${base}${concrete(def.path)}`, {
          method: def.method,
          headers: AUTH,
          body: fd,
        });
        await expectRefusedNaming(res, "bogus_field", what);
      });
    }
  }
});

describe("the list filters refuse a value they don't take", () => {
  const get = (path: string) => SELF.fetch(`${base}${path}`, { headers: AUTH });

  it("GET /api/posts?status=bogus is a 400 naming status", async () => {
    await expectRefusedNaming(await get("/api/posts?status=bogus"), "status", "bogus");
  });

  it("a comma list with one unknown status is a 400 naming status", async () => {
    await expectRefusedNaming(await get("/api/posts?status=draft,bogus"), "status", "list");
  });

  it("an empty status is a 400, not every post", async () => {
    await expectRefusedNaming(await get("/api/posts?status="), "status", "empty");
  });

  it("the declared statuses still filter, alone or as a comma list", async () => {
    for (const q of ["draft", "draft,scheduled", "draft, scheduled", "sent"]) {
      const res = await get(`/api/posts?status=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
  });

  it("GET /api/subscribers?suppressed=maybe is a 400 naming suppressed", async () => {
    await expectRefusedNaming(
      await get("/api/subscribers?suppressed=maybe"),
      "suppressed",
      "maybe",
    );
  });

  it("GET /api/subscribers?status=gone is a 400 naming status", async () => {
    await expectRefusedNaming(await get("/api/subscribers?status=gone"), "status", "gone");
  });

  it("the subscriber filters the editor sends still pass", async () => {
    const res = await get("/api/subscribers?status=confirmed&suppressed=hide&limit=1");
    expect(res.status).toBe(200);
  });
});

describe("a nested body field is checked at its own level", () => {
  it("PUT /api/settings with a misnamed publication field names its full path", async () => {
    const res = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ publication: { nmae: "x" } }),
    });
    const body = await readJson(res);
    expect(res.status).toBe(400);
    expect(body.field).toBe("publication.nmae");
    expect(body.message).toBe(
      "publication.nmae isn’t a field this takes; it takes 'name', 'tagline', 'address'",
    );
  });

  it("declared nested fields still save", async () => {
    const res = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ publication: { name: "Strict Door" } }),
    });
    expect(res.status).toBe(200);
  });

  it("a declared form upload still passes", async () => {
    const created = await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: "Strict door" }),
    });
    const id = (await readJson(created)).post.id;
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "dot.png", { type: "image/png" }));
    fd.append("filename", "dot.png");
    const res = await SELF.fetch(`${base}/api/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(res.status).toBe(201);
  });
});
