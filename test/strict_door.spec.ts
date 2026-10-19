// Strict at the door (docs/API.md principle 7): every API route refuses a query parameter,
// a query value, or a body key its manifest entry doesn't declare, with a 400 naming it,
// before its handler runs. Walks the manifest, so a new route is held to it by declaring.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, isReaderPath } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import type { RouteDef } from "../src/router";
import { resetDatabase } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

const defs: RouteDef[] = createRouter(getConfig(env as AppEnv)).routes.map((r) => r.def);
const apiRoutes = defs.filter((d) => d.access !== "webhook" && !isReaderPath(d.path));
const label = (d: RouteDef) => `${d.method} ${d.path}`;

/** The route's path with each parameter filled, so it matches; the check runs before any
 *  handler looks the id up. */
function pathOf(d: RouteDef): string {
  return d.path.replace(/:(\w+)(\([^)]*\))?/g, "x");
}

function call(d: RouteDef, query: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${base}${pathOf(d)}?${query}`, {
    method: d.method,
    headers: AUTH,
    ...init,
  });
}

/** The 400 a refusal at the door is, and the field it names. */
async function refusedNaming(res: Response): Promise<[number, string, string]> {
  const body = await readJson(res);
  return [res.status, body.error, body.field];
}

beforeEach(resetDatabase);

describe("strict at the door: the manifest is what a route takes", () => {
  it("covers the API: every admin route, and the dev token", () => {
    expect(apiRoutes.length).toBeGreaterThan(50);
    expect(apiRoutes.some((d) => d.path === "/api/dev/token")).toBe(true);
  });

  it("refuses a query parameter a route doesn't declare, naming it", async () => {
    for (const d of apiRoutes) {
      const res = await call(d, "zz_unknown=1");
      expect(await refusedNaming(res), label(d)).toEqual([400, "bad_request", "zz_unknown"]);
    }
  });

  it("refuses a value outside a parameter's declared values, naming it", async () => {
    let checked = 0;
    for (const d of apiRoutes) {
      for (const q of d.query ?? []) {
        if (!q.values) {
          continue;
        }
        checked++;
        const res = await call(d, `${q.name}=zz_bogus`);
        expect(await refusedNaming(res), `${label(d)} ${q.name}`).toEqual([
          400,
          "bad_request",
          q.name,
        ]);
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it("refuses a parameter given twice, naming it", async () => {
    const d = apiRoutes.find((r) => r.method === "GET" && r.path === "/api/posts")!;
    expect(await refusedNaming(await call(d, "search=a&search=b"))).toEqual([
      400,
      "bad_request",
      "search",
    ]);
  });

  it("refuses a JSON body key a route doesn't declare, at the top and in a nested field", async () => {
    const json = apiRoutes.filter((d) => d.accepts?.includes("application/json"));
    expect(json.length).toBeGreaterThan(10);
    for (const d of json) {
      const res = await call(d, "", {
        headers: JSON_AUTH,
        body: JSON.stringify({ zz_unknown: 1 }),
      });
      expect(await refusedNaming(res), label(d)).toEqual([400, "bad_request", "zz_unknown"]);
      // Each object a dotted field declares (`publication.name`) refuses a key of its own.
      const parents = new Set(
        (d.body ?? []).filter((f) => f.name.includes(".")).map((f) => f.name.split(".")[0]!),
      );
      for (const parent of parents) {
        const nested = await call(d, "", {
          headers: JSON_AUTH,
          body: JSON.stringify({ [parent]: { zz_unknown: 1 } }),
        });
        expect(await refusedNaming(nested), `${label(d)} ${parent}`).toEqual([
          400,
          "bad_request",
          `${parent}.zz_unknown`,
        ]);
      }
    }
  });

  it("refuses a form part a route doesn't declare, naming it", async () => {
    const forms = apiRoutes.filter((d) => d.accepts?.includes("multipart/form-data"));
    expect(forms.length).toBeGreaterThan(1);
    for (const d of forms) {
      const form = new FormData();
      form.set("zz_unknown", "1");
      const res = await call(d, "", { body: form });
      expect(await refusedNaming(res), label(d)).toEqual([400, "bad_request", "zz_unknown"]);
    }
  });

  it("names every declared value in the parameter's description, so the reference shows them", () => {
    for (const d of apiRoutes) {
      for (const q of d.query ?? []) {
        for (const v of q.values ?? []) {
          expect(q.description, `${label(d)} ${q.name}`).toContain(`\`${v}\``);
        }
      }
    }
  });
});

describe("the list filters are held to their values", () => {
  it("refuses an unknown post status, alone or in a comma list, and takes a list of known ones", async () => {
    for (const status of ["bogus", "draft,bogus", "draft,", ""]) {
      const res = await SELF.fetch(`${base}/api/posts?status=${status}`, { headers: AUTH });
      expect(await refusedNaming(res), status).toEqual([400, "bad_request", "status"]);
    }
    const ok = await SELF.fetch(`${base}/api/posts?status=draft,scheduled`, { headers: AUTH });
    expect(ok.status).toBe(200);
  });

  it("refuses an unknown subscriber status or suppression facet", async () => {
    for (const [q, field] of [
      ["suppressed=maybe", "suppressed"],
      ["status=bounced", "status"],
    ]) {
      const res = await SELF.fetch(`${base}/api/subscribers?${q}`, { headers: AUTH });
      expect(await refusedNaming(res), q).toEqual([400, "bad_request", field]);
    }
    const ok = await SELF.fetch(`${base}/api/subscribers?status=confirmed&suppressed=hide`, {
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
  });
});

describe("a reader page takes what a link carries", () => {
  it("answers the archive with a parameter an email's link gathered", async () => {
    const res = await SELF.fetch(`${base}/?utm_source=newsletter`);
    expect(res.status).toBe(200);
  });
});
