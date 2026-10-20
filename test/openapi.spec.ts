import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// @ts-expect-error cli/ is plain Node with no type declarations.
import { describeRoute, nextMove } from "../cli/openapi.mjs";
import { createRouter } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import { buildReferenceResponse } from "../src/reference";
import { OBJECTS } from "../src/reference/objects";
import {
  fieldSchema,
  type OpenApiDocument,
  objectSchema,
  openApiDocument,
  openApiPath,
  type Schema,
} from "../src/reference/openapi";
import { REFUSAL_MOVE, type RefusalCode } from "../src/reference/refusals";
import { AUTH, base } from "./support/http";

// The OpenAPI document is a projection of the same reference the editor and the Markdown read
// (SPEC §11), so these hold it to the registration: every route and object appears, and the
// document is well formed enough for tooling to import.

const router = createRouter(getConfig(env as AppEnv));
const defs = router.routes.map((r) => r.def);
const ref = buildReferenceResponse(defs);
const doc = openApiDocument(ref, base, "1.2.3");
const keys = new Set<string>(Object.keys(OBJECTS));

const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

/** Every value in a JSON tree, so a check can visit each `$ref` wherever it sits. */
function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const v of value) {
      yield* walk(v);
    }
  } else if (value && typeof value === "object") {
    yield value as Record<string, unknown>;
    for (const v of Object.values(value)) {
      yield* walk(v);
    }
  }
}

const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({ path, method, op })),
);

describe("the OpenAPI document is well formed (OpenAPI 3.1)", () => {
  it("names its version, the build's version, and the server it was read from", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
    expect(doc.info.title).toBe("Kestrel API");
    expect(doc.servers).toEqual([{ url: base }]);
  });

  it("round-trips through JSON unchanged, so what is served is the document built", () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("has only paths that start with a slash and carry no route-pattern syntax", () => {
    for (const path of Object.keys(doc.paths)) {
      expect(path).toMatch(/^\//);
      expect(path).not.toMatch(/[:()*]/);
    }
  });

  it("declares exactly the path parameters each path templates, each required", () => {
    for (const { path, op } of operations) {
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? []).filter((p) => p.in === "path");
      expect(declared.map((p) => p.name)).toEqual(templated);
      expect(declared.every((p) => p.required)).toBe(true);
    }
  });

  it("gives each operation a unique operationId, a known method, and responses keyed by status", () => {
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { method, op } of operations) {
      expect(METHODS.has(method)).toBe(true);
      expect(Object.keys(op.responses).length).toBeGreaterThan(0);
      for (const status of Object.keys(op.responses)) {
        expect(status).toMatch(/^(default|[1-5]XX|[1-5]\d\d)$/);
        expect(typeof op.responses[status]!.description).toBe("string");
      }
    }
  });

  it("resolves every $ref to a schema it defines", () => {
    const refs = [...walk(doc)].map((n) => n.$ref).filter((r) => r !== undefined);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas[String(r).split("/").pop() as string]).toBeDefined();
    }
  });

  it("names only security schemes and tags it defines", () => {
    const schemes = new Set(Object.keys(doc.components.securitySchemes));
    const requirements = [...doc.security, ...operations.flatMap((o) => o.op.security ?? [])];
    for (const req of requirements) {
      for (const name of Object.keys(req)) {
        expect(schemes.has(name)).toBe(true);
      }
    }
    const tags = new Set(doc.tags.map((t) => t.name));
    for (const { op } of operations) {
      for (const tag of op.tags) {
        expect(tags.has(tag)).toBe(true);
      }
    }
  });

  it("declares the optional Kestrel-Client header on every admin route, and on no other (SPEC §11)", () => {
    for (const d of defs) {
      const op = doc.paths[openApiPath(d.path)]![d.method.toLowerCase()]!;
      const headers = (op.parameters ?? []).filter((p) => p.in === "header");
      if (d.access === "admin") {
        expect(headers).toEqual([
          expect.objectContaining({
            name: "Kestrel-Client",
            required: false,
            schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 32 },
          }),
        ]);
      } else {
        expect(headers).toEqual([]);
      }
    }
  });

  it("gives a request body only to a route that takes one, under each type it accepts", () => {
    for (const d of defs) {
      const op = doc.paths[openApiPath(d.path)]![d.method.toLowerCase()]!;
      expect(Object.keys(op.requestBody?.content ?? {})).toEqual([...(d.accepts ?? [])]);
    }
  });
});

describe("the OpenAPI document lists everything the reference does", () => {
  it("has an operation for every registered route, and no other", () => {
    const listed = operations.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
    const registered = defs.map((d) => `${d.method} ${openApiPath(d.path)}`).sort();
    expect(listed).toEqual(registered);
  });

  it("takes each operation's title, tier, and own refusals from its route", () => {
    for (const d of defs) {
      const op = doc.paths[openApiPath(d.path)]![d.method.toLowerCase()]!;
      expect(op.summary).toBe(d.title);
      expect(op["x-kestrel-access"]).toBe(d.access);
      // A public route or a webhook takes no credential; an admin route inherits the document's.
      expect(op.security).toEqual(d.access === "admin" ? undefined : []);
      const codes = Object.entries(op.responses)
        .filter(([status]) => /^\d+$/.test(status))
        .flatMap(([, r]) => {
          const schema = r.content?.["application/json"]?.schema;
          return (schema?.allOf?.[1]?.properties?.error?.enum ?? []) as string[];
        });
      expect(codes.sort()).toEqual((d.errors ?? []).map((e) => e.code).sort());
      expect((op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name)).toEqual(
        (d.query ?? []).map((q) => q.name),
      );
    }
  });

  it("has a schema for every object the reference describes, with every field it lists", () => {
    for (const [key, o] of Object.entries(OBJECTS)) {
      const schema = doc.components.schemas[key]!;
      expect(schema.title).toBe(o.title);
      for (const f of o.fields) {
        // `…` says a row's list goes on, which no schema can name.
        const names = f.name.split(",").map((n) => n.trim());
        for (const name of names.filter((n) => n !== "…")) {
          const path = name.split(".");
          let node: Schema | undefined = schema;
          for (const part of path) {
            node = node?.properties?.[part];
          }
          expect(node, `${key}.${name}`).toBeDefined();
        }
      }
    }
  });

  it("names each refusal any route gives with its status and next move, which kestrel api prints", () => {
    const shared = doc.paths["/api/posts"]!.post!.responses.default!.description;
    expect(shared).toMatch(/^A refusal any route can give: /);
    expect(shared).toContain("`unauthorized` (401; next move: Sign in, or stop)");
    expect(shared).toContain("`unsupported_media_type` (415; next move: Fix the request)");
  });

  it("names the object a route returns, as the route's answer", () => {
    const send = doc.paths["/api/sends/{id}"]!.get!.responses["2XX"]!.content?.["application/json"];
    expect(send?.schema.properties?.send).toEqual({ $ref: "#/components/schemas/send" });
    expect(send?.schema.required).toEqual(["send"]);
  });
});

describe("a documented type reads as a schema", () => {
  const schema = (type: string, extra: object = {}) =>
    fieldSchema({ name: "x", type, description: "d", ...extra }, keys);

  it("reads the plain types, a nullable one, a list, and literal unions", () => {
    expect(schema("string")).toEqual({ type: "string", description: "d" });
    expect(schema("number | null")).toEqual({ type: ["number", "null"], description: "d" });
    expect(schema("string[]")).toEqual({
      type: "array",
      items: { type: "string" },
      description: "d",
    });
    expect(schema('"unsent" | "accepted"')).toEqual({
      enum: ["unsent", "accepted"],
      description: "d",
    });
    expect(schema("string or string[]")).toEqual({
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: "d",
    });
  });

  it("links an object the reference describes, as a list or nullable too", () => {
    expect(schema("condition[]")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/condition" },
      description: "d",
    });
    expect(schema("halt | null")).toEqual({
      anyOf: [{ $ref: "#/components/schemas/halt" }, { type: "null" }],
      description: "d",
    });
    expect(schema("object", { object: "send" })).toEqual({
      $ref: "#/components/schemas/send",
      description: "d",
    });
  });

  it("lists a field's documented values as its enum, and keeps an unknown form loose", () => {
    expect(schema("string", { values: [{ value: "a", description: "" }] })).toEqual({
      enum: ["a"],
      description: "d",
    });
    expect(schema("a shape no reader knows")).toEqual({ description: "d" });
  });

  it("nests a dotted field under its parent, a required one making its parent required", () => {
    const body = objectSchema(
      [
        { name: "file.name", type: "string", description: "n", required: true },
        { name: "plan_hash", type: "string", description: "h" },
      ],
      keys,
    );
    expect(body).toEqual({
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", description: "n" } },
        },
        plan_hash: { type: "string", description: "h" },
      },
    });
  });
});

describe("/api/openapi.json is served like the rest of the authed admin surface", () => {
  it("401s without a token", async () => {
    expect((await SELF.fetch(`${base}/api/openapi.json`)).status).toBe(401);
  });

  it("answers the document as JSON when authed, for the origin it was asked at", async () => {
    const res = await SELF.fetch(`${base}/api/openapi.json`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as OpenApiDocument;
    expect(body.openapi).toBe("3.1.0");
    expect(body.servers).toEqual([{ url: base }]);
    expect(body.paths["/api/openapi.json"]!.get!.operationId).toBe("get-openapi-document");
  });
});

describe("kestrel api reads this document's refusals (SPEC §11)", () => {
  // The CLI parses the wording this projection writes; a change to it must fail here, not
  // silently drop every refusal from `kestrel api help` and its readable refusals.
  it("finds every route's own refusals, each with its next move", () => {
    for (const d of ref.groups.flatMap((g) => g.routes)) {
      const method = d.method.toLowerCase();
      const path = openApiPath(d.path);
      const text: string = describeRoute(doc, method, path);
      const op = doc.paths[path]![method]!;
      for (const e of d.errors ?? []) {
        expect(text, `${d.method} ${path} ${e.code}`).toContain(`  ${e.status} ${e.code}: `);
        expect(nextMove(doc, e.code, op), `${d.method} ${path} ${e.code}`).toBe(
          REFUSAL_MOVE[e.code as RefusalCode],
        );
      }
    }
  });

  it("finds the next move on each refusal any route gives", () => {
    for (const code of ["unauthorized", "unsupported_media_type", "internal_error"] as const) {
      expect(nextMove(doc, code)).toBe(REFUSAL_MOVE[code]);
    }
  });
});
