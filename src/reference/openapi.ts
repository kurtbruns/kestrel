/**
 * The API reference as an OpenAPI 3.1 document, the shape standard tooling reads (client
 * codegen, Postman or Insomnia import, contract tests). It is a third projection of the same
 * `ReferenceResponse` the editor renders and the Markdown is written from, so it describes no
 * route, field, object, or refusal of its own: the route manifest (src/app.ts) and
 * src/reference/ stay the one definition, and this can't drift from them.
 *
 * The manifest documents a field's type as a short human string (`number | null`, `"a" | "b"`,
 * `condition[]`), not a schema, so `fieldSchema` reads the forms the reference writes and keeps
 * any other as a schema that accepts anything, its words in the description. The manifest
 * names no success status (most routes answer 200, a create 201) and no answer type beyond what
 * a route returns, so each operation answers `2XX`, with a JSON body only where it says what
 * that body is. Served read-only at the authed `/api/openapi.json`.
 */

import {
  concretePath,
  type ObjectKey,
  type ReferenceEntry,
  type ReferenceField,
  type ReferenceResponse,
  type RouteReturns,
  routeAnchor,
  sharedRefusals,
} from "../../shared/reference";
import { CLIENT_HEADER, CLIENT_NAME_MAX, CLIENT_NAME_PATTERN } from "../../shared/who_acted";
import { REFUSAL_MEANING, type RefusalCode } from "./refusals";

/** A JSON Schema (2020-12, as OpenAPI 3.1 uses it), loose enough to build field by field. */
export interface Schema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  allOf?: Schema[];
  $ref?: string;
  format?: string;
  pattern?: string;
  maxLength?: number;
  contentMediaType?: string;
  title?: string;
  description?: string;
  examples?: unknown[];
}

/** The parts of an OpenAPI 3.1 document this projection writes. */
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description?: string }[];
  security: Record<string, string[]>[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, Record<string, string>>;
  };
}

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: Schema;
}

interface MediaType {
  schema: Schema;
  example?: unknown;
}

interface Operation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  "x-kestrel-access": ReferenceEntry["access"];
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required: true; content: Record<string, MediaType> };
  responses: Record<string, { description: string; content?: Record<string, MediaType> }>;
}

/** The schema an object's section is under, as a `$ref` names it. */
function objectRef(key: ObjectKey): Schema {
  return { $ref: `#/components/schemas/${key}` };
}

const ERROR_REF: Schema = { $ref: "#/components/schemas/error" };

/** Split on `sep` outside braces, so `{ reason, detail } | null` splits once. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * One alternative of a documented type as a schema, or null when it isn't a form the reference
 * writes. `object` is the object the field names, which a bare `object` stands for.
 */
function termSchema(term: string, keys: ReadonlySet<string>, object?: ObjectKey): Schema | null {
  if (term.endsWith("[]")) {
    const items = termSchema(term.slice(0, -2).trim(), keys, object);
    return items ? { type: "array", items } : null;
  }
  const literal = /^"([^"]*)"$/.exec(term);
  if (literal) {
    return { const: literal[1] };
  }
  if (term.startsWith("{") && term.endsWith("}")) {
    const names = splitTop(term.slice(1, -1), ",").filter((n) => /^\w+$/.test(n));
    return { type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) };
  }
  switch (term) {
    case "string":
    case "number":
    case "boolean":
    case "integer":
    case "null":
      return { type: term };
    case "true":
    case "false":
      return { const: term === "true" };
    case "epoch ms":
      return { type: "integer", description: "Epoch milliseconds." };
    case "ISO-8601":
      return { type: "string", format: "date-time" };
    case "file":
      return { type: "string", contentMediaType: "application/octet-stream" };
    case "object":
      return object ? objectRef(object) : { type: "object" };
  }
  return keys.has(term) ? objectRef(term as ObjectKey) : null;
}

/** Alternatives as one schema: a plain type and `null` as a type pair, literals as an enum. */
function unionSchema(alts: Schema[]): Schema {
  const [first] = alts;
  if (alts.length === 1 && first) {
    return first;
  }
  const consts = alts.filter((a) => "const" in a && Object.keys(a).length === 1);
  if (consts.length === alts.length) {
    return { enum: consts.map((a) => a.const) };
  }
  const nonNull = alts.filter((a) => a.type !== "null");
  const only = nonNull[0];
  if (
    nonNull.length === 1 &&
    only &&
    typeof only.type === "string" &&
    Object.keys(only).every((k) => k === "type" || k === "format" || k === "description")
  ) {
    return { ...only, type: [only.type, "null"] };
  }
  return { anyOf: alts };
}

/**
 * A documented field's schema, read from its type string, its `object`, and its listed values.
 * A type the reference words some other way is kept as a schema that accepts anything, its
 * words left to the description, since a wrong schema would be worse than a loose one.
 */
export function fieldSchema(f: ReferenceField, keys: ReadonlySet<string>): Schema {
  const terms = splitTop(f.type, " or ").flatMap((t) => splitTop(t, "|"));
  const alts = terms.map((t) => termSchema(t, keys, f.object));
  let schema: Schema = alts.length && alts.every((a) => a !== null) ? unionSchema(alts) : {};
  if (f.values?.length) {
    const values = f.values.map((v) => v.value);
    const nullable = terms.includes("null");
    // Values listed on an array field are its items' values.
    schema =
      schema.type === "array"
        ? { type: "array", items: { enum: values } }
        : { enum: nullable ? [...values, null] : values };
  }
  return { ...schema, description: f.description };
}

/** A field's documented names: a row may name several (`confirm_token, unsub_token`), and a
 *  trailing `…` says the list goes on, which no schema can name. */
function fieldNames(name: string): string[] {
  return name
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "" && n !== "…");
}

/**
 * Fields as one object schema, a dotted name (`publication.name`) nested under its parent's
 * properties. A required nested field makes its parent required too, since the field can't
 * be sent without it.
 */
export function objectSchema(
  fields: readonly (ReferenceField & { required?: boolean })[],
  keys: ReadonlySet<string>,
): Schema {
  const root: Schema = { type: "object", properties: {} };
  for (const f of fields) {
    for (const name of fieldNames(f.name)) {
      const path = name.split(".");
      let node = root;
      for (const [i, part] of path.entries()) {
        node.properties ??= {};
        if (f.required && !node.required?.includes(part)) {
          node.required = [...(node.required ?? []), part];
        }
        if (i === path.length - 1) {
          const own = fieldSchema(f, keys);
          const kept = node.properties[part]?.properties;
          node.properties[part] = kept ? { ...own, type: "object", properties: kept } : own;
        } else {
          node.properties[part] ??= { type: "object" };
          node = node.properties[part];
          node.type ??= "object";
        }
      }
    }
  }
  return root;
}

/** What a route answers, as a schema: the object (under `as`, or the whole body), and its own fields. */
function returnsSchema(r: RouteReturns, keys: ReadonlySet<string>): Schema {
  const own = r.fields?.length ? objectSchema(r.fields, keys) : undefined;
  if (!r.object) {
    return own ?? { type: "object" };
  }
  const object = r.list ? { type: "array", items: objectRef(r.object) } : objectRef(r.object);
  if (r.as) {
    const base: Schema = { type: "object", properties: { [r.as]: object }, required: [r.as] };
    return own ? { ...base, properties: { ...base.properties, ...own.properties } } : base;
  }
  return own ? { allOf: [object, own] } : object;
}

/** A manifest path as an OpenAPI path: the pattern syntax dropped, `:id` as `{id}`. */
export function openApiPath(path: string): string {
  return concretePath(path).replace(/:(\w+)/g, "{$1}");
}

/** A path's parameters, in the order they appear. */
function pathParams(path: string): string[] {
  return [...openApiPath(path).matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
}

/** The schemes an admin route takes: a deployed instance's Access service token (both headers),
 *  or a local instance's dev token. */
const SECURITY_SCHEMES = {
  access_client_id: {
    type: "apiKey",
    in: "header",
    name: "CF-Access-Client-Id",
    description: "A Cloudflare Access service token's ID, sent with its secret.",
  },
  access_client_secret: {
    type: "apiKey",
    in: "header",
    name: "CF-Access-Client-Secret",
    description: "A Cloudflare Access service token's secret, sent with its ID.",
  },
  dev_token: {
    type: "http",
    scheme: "bearer",
    description: "On a local instance only: the dev token that stands in for Access.",
  },
};

/** The header a client names itself in, which every admin route takes and none requires. */
const CLIENT_PARAMETER: Parameter = {
  name: CLIENT_HEADER,
  in: "header",
  required: false,
  description:
    "The program the request came from, in one short lowercase word (`editor`, `claude-code`), recorded beside who made a change. A malformed name is a 400 naming this header; a service token's is ignored.",
  schema: { type: "string", pattern: CLIENT_NAME_PATTERN, maxLength: CLIENT_NAME_MAX },
};

const ADMIN_SECURITY: Record<string, string[]>[] = [
  { access_client_id: [], access_client_secret: [] },
  { dev_token: [] },
];

/** One route as an operation. */
function operation(
  r: ReferenceEntry,
  tag: string,
  keys: ReadonlySet<string>,
  shared: ReturnType<typeof sharedRefusals>,
): Operation {
  const parameters: Parameter[] = [
    ...pathParams(r.path).map(
      (name): Parameter => ({ name, in: "path", required: true, schema: { type: "string" } }),
    ),
    ...(r.query ?? []).map(
      (q): Parameter => ({
        name: q.name,
        in: "query",
        required: q.required ?? false,
        description: q.description,
        // A fixed set is an enum; a comma list of one stays a string, its values in the prose.
        schema: q.values && !q.list ? { type: "string", enum: [...q.values] } : { type: "string" },
      }),
    ),
    ...(r.access === "admin" ? [CLIENT_PARAMETER] : []),
  ];
  const op: Operation = {
    operationId: routeAnchor(r),
    summary: r.title,
    description: r.description ? `${r.summary}\n\n${r.description}` : r.summary,
    tags: [tag],
    "x-kestrel-access": r.access,
    ...(r.access === "admin" ? {} : { security: [] }),
    ...(parameters.length ? { parameters } : {}),
    responses: {},
  };
  if (r.accepts?.length) {
    // JSON and a form carry the documented fields; a raw upload is the file itself.
    const fields = r.body?.length ? objectSchema(r.body, keys) : { type: "object" };
    op.requestBody = {
      required: true,
      content: Object.fromEntries(
        r.accepts.map((type) => {
          const structured = type === "application/json" || type === "multipart/form-data";
          const media: MediaType = {
            schema: structured ? fields : { type: "string", contentMediaType: type },
          };
          if (type === "application/json" && r.example?.request !== undefined) {
            media.example = r.example.request;
          }
          return [type, media];
        }),
      ),
    };
  }
  const answer: Operation["responses"][string] = { description: r.summary };
  if (r.returns || r.example?.response !== undefined) {
    const media: MediaType = { schema: r.returns ? returnsSchema(r.returns, keys) : {} };
    if (r.example?.response !== undefined) {
      media.example = r.example.response;
    }
    answer.content = { "application/json": media };
  }
  op.responses["2XX"] = answer;
  // The route's own refusals, by status, each code with when it's given and the next move.
  const byStatus = new Map<number, NonNullable<ReferenceEntry["errors"]>>();
  for (const e of r.errors ?? []) {
    byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e]);
  }
  for (const [status, errors] of [...byStatus].sort(([a], [b]) => a - b)) {
    op.responses[String(status)] = {
      description: errors
        .map(
          (e) =>
            `\`${e.code}\`: ${e.when ?? REFUSAL_MEANING[e.code as RefusalCode]} Next move: ${e.move}.`,
        )
        .join("\n\n"),
      content: {
        "application/json": {
          schema: {
            allOf: [
              ERROR_REF,
              { type: "object", properties: { error: { enum: errors.map((e) => e.code) } } },
            ],
          },
        },
      },
    };
  }
  op.responses.default = {
    description: `A refusal any route can give: ${shared.map((c) => `\`${c.code}\` (${c.status})`).join(", ")}.`,
    content: { "application/json": { schema: ERROR_REF } },
  };
  return op;
}

/**
 * The OpenAPI document for this instance: the reference's topics as its description, each
 * object and the refusal body as a schema, and each route as an operation tagged with its
 * resource. `origin` is the server the paths hang off, `version` the build's.
 */
export function openApiDocument(
  ref: ReferenceResponse,
  origin: string,
  version: string,
): OpenApiDocument {
  const keys = new Set<string>(ref.objects.map((o) => o.key));
  const shared = sharedRefusals(ref);
  const errors = ref.concepts.find((c) => c.key === "errors");
  const schemas: Record<string, Schema> = {
    error: {
      ...objectSchema(errors?.fields ?? [], keys),
      title: "Refusal",
      description: "A refusal's body.",
      required: ["error", "message"],
    },
  };
  for (const o of ref.objects) {
    schemas[o.key] = {
      ...objectSchema(o.fields, keys),
      title: o.title,
      description: o.description,
      examples: [o.example],
    };
  }

  const resources = new Map(ref.groups.flatMap((g) => g.resources.map((r) => [r.key, r.title])));
  const paths: OpenApiDocument["paths"] = {};
  for (const r of ref.groups.flatMap((g) => g.routes)) {
    const path = openApiPath(r.path);
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = operation(
      r,
      resources.get(r.resource) ?? r.resource,
      keys,
      shared,
    );
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Kestrel API",
      version,
      description: [
        "Every route this instance serves, read from its running code. The same reference, for a person or an agent to read, is at `GET /api/reference.md`.",
        ...ref.concepts.map((c) => `## ${c.title}\n\n${c.text}`),
      ].join("\n\n"),
    },
    servers: [{ url: origin }],
    tags: [...new Set(resources.values())].map((name) => ({ name })),
    security: ADMIN_SECURITY,
    paths,
    components: { schemas, securitySchemes: SECURITY_SCHEMES },
  };
}
