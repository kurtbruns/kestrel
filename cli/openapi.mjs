/*
 * What `kestrel api` reads from an instance's OpenAPI document (`GET /api/openapi.json`): its
 * routes to list and describe, the route a call names, the body or query string that `-f` and
 * `-F` fields build, and a refusal's next move.
 *
 * The document is the instance's own, read through the same sign-in as the call, so what this
 * prints matches the release that instance runs, never this CLI's. It is the Worker's
 * projection of its route manifest (src/reference/openapi.ts): resources are tags, a field is
 * a schema, and a refusal's next move is written into its response's description, as
 * "`code`: when. Next move: move." for a route's own and "`code` (status; next move: move)"
 * for one any route gives.
 *
 * A field the route doesn't declare is refused here, before the request, with the route's
 * field list, by the same rule the router applies (src/lib/strict.ts): a declared field with
 * no declared children is read whole, so the check stops there. Whether a value is right
 * beyond its type stays the instance's to say.
 */
import { readFileSync } from "node:fs";

const METHODS = ["get", "put", "post", "delete", "patch"];

/** Every operation in the document, as `{ method, path, op }`, in its order. */
export function operations(doc) {
  const ops = [];
  for (const [path, byMethod] of Object.entries(doc?.paths ?? {})) {
    for (const [method, op] of Object.entries(byMethod ?? {})) {
      if (METHODS.includes(method)) {
        ops.push({ method: method.toUpperCase(), path, op });
      }
    }
  }
  return ops;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The operation `method path` calls, or undefined. A concrete path (`/api/posts/p_1`) matches
 * its template, as does the template itself, and a literal segment beats a parameter, so
 * `/api/sends/feed` is the feed rather than a send named "feed".
 */
export function findOperation(doc, method, path) {
  const bare = path.split(/[?#]/)[0];
  let best;
  for (const o of operations(doc)) {
    if (o.method !== method.toUpperCase()) {
      continue;
    }
    const pattern = o.path
      .split(/(\{\w+\})/)
      .map((part) => (/^\{\w+\}$/.test(part) ? "[^/]+" : escapeRe(part)))
      .join("");
    if (!new RegExp(`^${pattern}$`).test(bare)) {
      continue;
    }
    const literal = o.path.replace(/\{\w+\}/g, "").length;
    if (!best || literal > best.literal) {
      best = { ...o, literal };
    }
  }
  return best && { method: best.method, path: best.path, op: best.op };
}

/** A schema with its `$ref` followed into the document's components. */
function resolve(schema, doc) {
  let s = schema;
  for (let i = 0; s?.$ref && i < 10; i++) {
    s = doc?.components?.schemas?.[s.$ref.split("/").pop()];
  }
  return s ?? {};
}

/** A schema as one short type, as the reference writes it: `string | null`, `"a" | "b"`, `post`. */
export function typeName(schema) {
  if (!schema || typeof schema !== "object") {
    return "any";
  }
  if (schema.$ref) {
    return schema.$ref.split("/").pop();
  }
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (schema.anyOf) {
    return schema.anyOf.map(typeName).join(" | ");
  }
  if (schema.allOf) {
    return schema.allOf.map(typeName).join(" & ");
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (!types.length) {
    return "any";
  }
  return types
    .map((t) => {
      if (t === "array") {
        const items = typeName(schema.items);
        return items.includes(" ") ? `(${items})[]` : `${items}[]`;
      }
      return t === "string" && schema.format ? `string (${schema.format})` : t;
    })
    .join(" | ");
}

/** An object schema's fields, a nested object's under dotted names, as `{ name, schema, required }`. */
function flatFields(schema, doc, prefix = "") {
  const s = resolve(schema, doc);
  const rows = [];
  for (const [key, field] of Object.entries(s.properties ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    rows.push({ name, schema: field, required: (s.required ?? []).includes(key) });
    if (!field.$ref && field.properties) {
      rows.push(...flatFields(field, doc, name));
    }
  }
  return rows;
}

/** The JSON body schema a route takes, or undefined when it takes none. */
function jsonBody(op) {
  return op.requestBody?.content?.["application/json"]?.schema;
}

/** The query parameters a route declares. */
function queryParams(op) {
  return (op.parameters ?? []).filter((p) => p.in === "query");
}

/** Text indented under a row, one paragraph per line. */
function indent(text, by) {
  return String(text)
    .split(/\n+/)
    .map((line) => `${" ".repeat(by)}${line}`)
    .join("\n");
}

/**
 * Every route the document describes, grouped by resource, one per line: its method, path,
 * and title, a route that takes no sign-in marked so. `resource` narrows it to one resource,
 * named as `--list` prints it, in any case.
 */
export function listRoutes(doc, resource) {
  const ops = operations(doc);
  const tagOf = (o) => o.op.tags?.[0] ?? "Other";
  const tags = [...new Set([...(doc.tags ?? []).map((t) => t.name), ...ops.map(tagOf)])].filter(
    (t) => ops.some((o) => tagOf(o) === t),
  );
  let shown = tags;
  if (resource !== undefined) {
    const tag = tags.find((t) => t.toLowerCase() === resource.toLowerCase());
    if (!tag) {
      throw new Error(
        `This instance has no resource named "${resource}"; it has ${tags.map((t) => t.toLowerCase()).join(", ")}.`,
      );
    }
    shown = [tag];
  }
  const rows = ops.filter((o) => shown.includes(tagOf(o)));
  const width = Math.min(Math.max(...rows.map((o) => o.path.length)), 44);
  const lines = [];
  for (const tag of shown) {
    lines.push(lines.length ? `\n${tag}` : tag);
    for (const o of rows.filter((r) => tagOf(r) === tag)) {
      const access = o.op["x-kestrel-access"];
      const marked = access && access !== "admin" ? ` (${access})` : "";
      lines.push(`  ${o.method.padEnd(6)} ${o.path.padEnd(width)}  ${o.op.summary ?? ""}${marked}`);
    }
  }
  lines.push(
    "",
    "`kestrel api help <method> <path>` describes one, its body and refusals among the rest.",
  );
  return lines.join("\n");
}

/** A route's refusals, by status, each `{ status, code, when, move }`. */
function refusalsOf(op) {
  const rows = [];
  for (const [status, res] of Object.entries(op.responses ?? {})) {
    if (!/^\d+$/.test(status)) {
      continue;
    }
    for (const chunk of String(res.description ?? "").split(/\n\n+/)) {
      const m = /^`([\w.-]+)`: ([\s\S]*?)\s*Next move: ([\s\S]+?)\.?$/.exec(chunk.trim());
      if (m) {
        rows.push({ status: Number(status), code: m[1], when: m[2], move: m[3] });
      }
    }
  }
  return rows;
}

/** The refusals any route gives, from the `default` answer, each `{ status, code, move }`. */
function sharedRefusalsOf(op) {
  const text = String(op.responses?.default?.description ?? "");
  return [...text.matchAll(/`([\w.-]+)` \((\d+)(?:; next move: ([^)]*))?\)/g)].map((m) => ({
    status: Number(m[2]),
    code: m[1],
    move: m[3],
  }));
}

/**
 * The next move on a refusal `code`: the route's own when `op` gives it, else what any route
 * says of it, since a code's move is the same wherever it is given. Undefined when the
 * document doesn't say.
 */
export function nextMove(doc, code, op) {
  const ordered = op ? [op, ...operations(doc).map((o) => o.op)] : operations(doc).map((o) => o.op);
  for (const candidate of ordered) {
    const found = [...refusalsOf(candidate), ...sharedRefusalsOf(candidate)].find(
      (r) => r.code === code && r.move,
    );
    if (found) {
      return found.move;
    }
  }
  return undefined;
}

/** One route, described for a person or Claude to call it: what it does, the parameters and body
 *  fields it takes, what it returns, and its refusals with their next moves. */
export function describeRoute(doc, method, path) {
  const found = findOperation(doc, method, path);
  if (!found) {
    throw new Error(
      `This instance has no route ${method.toUpperCase()} ${path}. \`kestrel api --list\` lists them.`,
    );
  }
  const { op } = found;
  const out = [
    `${found.method} ${found.path}`,
    `${op.summary}${op.tags?.[0] ? ` (${op.tags[0]})` : ""}`,
  ];
  if (op["x-kestrel-access"] && op["x-kestrel-access"] !== "admin") {
    out.push(`Access: ${op["x-kestrel-access"]}, no sign-in`);
  }
  if (op.description) {
    out.push("", op.description);
  }
  const params = (where) => (op.parameters ?? []).filter((p) => p.in === where);
  if (params("path").length) {
    out.push("", "Path parameters");
    for (const p of params("path")) {
      out.push(`  ${p.name}${p.description ? `\n${indent(p.description, 6)}` : ""}`);
    }
  }
  if (params("query").length) {
    out.push("", "Query parameters (give them with -f or -F)");
    for (const p of params("query")) {
      out.push(`  ${p.name}  ${typeName(p.schema)}${p.required ? ", required" : ""}`);
      if (p.description) {
        out.push(indent(p.description, 6));
      }
    }
  }
  const types = Object.keys(op.requestBody?.content ?? {});
  if (types.length) {
    out.push("", `Body: ${types.join(", ")}`);
    const structured =
      op.requestBody.content["application/json"] ?? op.requestBody.content["multipart/form-data"];
    const fields = structured ? flatFields(structured.schema, doc) : [];
    for (const f of fields) {
      out.push(`  ${f.name}  ${typeName(f.schema)}${f.required ? ", required" : ""}`);
      if (f.schema.description) {
        out.push(indent(f.schema.description, 6));
      }
    }
    const how = [];
    if (types.includes("application/json")) {
      how.push("-f/-F name=value or --data '<json>'");
    }
    if (types.includes("multipart/form-data")) {
      how.push("--form name=value or name=@file");
    }
    const raw = types.filter((t) => t !== "application/json" && t !== "multipart/form-data");
    if (raw.length) {
      how.push(`the file itself, with --data @file --type ${raw[0]}`);
    }
    out.push(`  Send it as ${how.join("; or ")}.`);
    const example = op.requestBody.content["application/json"]?.example;
    if (example !== undefined) {
      out.push("  Example:", indent(JSON.stringify(example, null, 2), 4));
    }
  }
  const success = op.responses?.["2XX"]?.content?.["application/json"];
  if (success) {
    const shape = resolve(success.schema, doc);
    const fields = success.schema?.$ref ? [] : flatFields(success.schema, doc);
    out.push("", "Returns");
    if (fields.length) {
      for (const f of fields.filter((r) => !r.name.includes("."))) {
        out.push(`  ${f.name}  ${typeName(f.schema)}`);
        if (f.schema.description) {
          out.push(indent(f.schema.description, 6));
        }
      }
    } else {
      out.push(`  ${typeName(success.schema)}${shape.title ? ` (${shape.title})` : ""}`);
    }
  }
  const own = refusalsOf(op);
  const shared = sharedRefusalsOf(op);
  if (own.length || shared.length) {
    out.push("", "Refusals");
    for (const r of own) {
      out.push(`  ${r.status} ${r.code}: ${r.when}`, `      Next move: ${r.move}.`);
    }
    if (shared.length) {
      out.push(`  Any route: ${shared.map((r) => `${r.code} (${r.status})`).join(", ")}`);
    }
  }
  return out.join("\n");
}

/** `name=value` split at its first `=`, or a refusal naming the flag. */
function splitField(flag, text) {
  const at = text.indexOf("=");
  if (at < 1) {
    throw new Error(`${flag} takes name=value, not "${text}".`);
  }
  return [text.slice(0, at), text.slice(at + 1)];
}

const NO = Symbol("no match");

/** A schema's alternatives, each one plain type, a literal, or nothing (anything). */
function alternatives(schema, doc) {
  const s = resolve(schema, doc);
  if (s.anyOf) {
    return s.anyOf.flatMap((a) => alternatives(a, doc));
  }
  if (s.enum) {
    return s.enum.map((v) => ({ const: v }));
  }
  if ("const" in s) {
    return [{ const: s.const }];
  }
  if (Array.isArray(s.type)) {
    return s.type.map((t) => ({ ...s, type: t }));
  }
  return s.type ? [s] : [];
}

/** `raw` read as one alternative's value, or NO. */
function asType(raw, alt) {
  if ("const" in alt) {
    return String(alt.const) === raw ? alt.const : NO;
  }
  switch (alt.type) {
    case "null":
      return raw === "null" ? null : NO;
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : NO;
    case "integer":
      return /^-?\d+$/.test(raw) ? Number(raw) : NO;
    case "number":
      return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : NO;
    case "object":
    case "array":
      try {
        const v = JSON.parse(raw);
        const fits =
          alt.type === "array" ? Array.isArray(v) : v && typeof v === "object" && !Array.isArray(v);
        return fits ? v : NO;
      } catch {
        return NO;
      }
    case "string":
      return raw;
    default:
      return NO;
  }
}

/**
 * The JSON value `-F` gives `raw` for a field of `schema`: `true`, `false`, `null`, a number,
 * or JSON for an object or list where the schema takes one, else the string; a string is tried
 * last, so `-F listed=true` is a boolean wherever a boolean is allowed. A field the document
 * leaves untyped takes JSON only for an object or a list, and is otherwise the string as
 * given. A value the schema can't take is refused.
 */
export function typedValue(raw, schema, name, doc) {
  const alts = alternatives(schema, doc).sort(
    (a, b) => Number(a.type === "string") - Number(b.type === "string"),
  );
  if (!alts.length) {
    // Untyped: an object or a list when it is one, else the string as given, so a loose
    // field never turns `2026` or `true` into a number or a boolean by surprise.
    for (const type of ["object", "array"]) {
      const v = asType(raw, { type });
      if (v !== NO) {
        return v;
      }
    }
    return raw;
  }
  for (const alt of alts) {
    const v = asType(raw, alt);
    if (v !== NO) {
      return v;
    }
  }
  throw new Error(`${name} takes ${typeName(resolve(schema, doc))}, not ${JSON.stringify(raw)}.`);
}

/** What a refusal says the route takes instead, as strict.ts words it. */
function takes(names) {
  return names.length ? `it takes ${names.map((n) => `'${n}'`).join(", ")}` : "it takes none";
}

/**
 * Build a call's `-f` and `-F` fields (`[{ typed, text }]`, in the order given) into what the
 * route takes: on a GET, its query string; otherwise its JSON body, except a name the route
 * declares as a query parameter and not as a body field, which goes in the query string.
 * `name.sub=value` nests, `name[]=value` adds to a list, and `-F name=@file` reads the value
 * from a file. A field the route doesn't declare, one given twice, or a body field for a
 * route with no JSON body is refused, naming what it takes. Answers `{ query, body }`: the
 * pairs to append, and the object, absent when no field is a body field.
 */
export function buildFields(
  doc,
  found,
  fields,
  { readFile = (f) => readFileSync(f, "utf8") } = {},
) {
  const label = `${found.method} ${found.path}`;
  const help = `\`kestrel api help ${label}\` describes it.`;
  const given = (typed, raw) => (typed && raw.startsWith("@") ? readFile(raw.slice(1)) : raw);
  const declared = queryParams(found.op);
  const root = found.method === "GET" ? undefined : jsonBody(found.op);
  const bodyNames = Object.keys(resolve(root, doc).properties ?? {});
  // A GET's fields are all its query string; on another method, a field the route declares as
  // a query parameter and not as a body field goes there too, and the rest make the body.
  const inQuery = (name) =>
    found.method === "GET" || (declared.some((p) => p.name === name) && !bodyNames.includes(name));
  const query = [];
  const bodyFields = [];
  for (const field of fields) {
    const [name, raw] = splitField(field.typed ? "-F" : "-f", field.text);
    if (!inQuery(name)) {
      bodyFields.push(field);
      continue;
    }
    const param = declared.find((p) => p.name === name);
    if (!param) {
      const names = declared.map((p) => p.name);
      throw new Error(`${name} isn’t a query parameter ${label} takes; ${takes(names)}. ${help}`);
    }
    if (query.some(([n]) => n === name)) {
      throw new Error(`${name} is given more than once; give it once.`);
    }
    const value = given(field.typed, raw);
    query.push([name, field.typed ? String(typedValue(value, param.schema, name, doc)) : value]);
  }
  if (!bodyFields.length) {
    return { query };
  }
  if (!root) {
    const types = Object.keys(found.op.requestBody?.content ?? {});
    const params = declared.length
      ? ` Its query parameters are ${declared.map((p) => `'${p.name}'`).join(", ")}.`
      : "";
    throw new Error(
      types.length
        ? `${label} takes no JSON body; it takes ${types.join(", ")}: send it with ${types.includes("multipart/form-data") ? "--form" : "--data @file --type <type>"}.${params} ${help}`
        : `${label} takes no body.${params} ${help}`,
    );
  }
  const body = {};
  for (const { typed, text } of bodyFields) {
    const [name, raw] = splitField(typed ? "-F" : "-f", text);
    const list = name.endsWith("[]");
    const parts = (list ? name.slice(0, -2) : name).split(".");
    if (parts.some((p) => p === "")) {
      throw new Error(`${name} isn't a field name: name a field, a nested one as parent.child.`);
    }
    let schema = root;
    let node = body;
    for (const [i, part] of parts.entries()) {
      const at = parts.slice(0, i + 1).join(".");
      const s = schema === undefined ? undefined : resolve(schema, doc);
      if (s?.properties) {
        if (!Object.hasOwn(s.properties, part)) {
          const names = Object.keys(s.properties);
          throw new Error(`${at} isn’t a field ${label} takes; ${takes(names)}. ${help}`);
        }
        schema = s.properties[part];
      } else {
        // A field declared without children is the route's to read whole.
        schema = undefined;
      }
      if (i < parts.length - 1) {
        node[part] ??= {};
        if (typeof node[part] !== "object" || node[part] === null || Array.isArray(node[part])) {
          throw new Error(`${at} is given a value and fields of its own; give one or the other.`);
        }
        node = node[part];
      }
    }
    const key = parts.join(".");
    const last = parts[parts.length - 1];
    const value = given(typed, raw);
    if (list) {
      const alts = schema === undefined ? [] : alternatives(schema, doc);
      const array = alts.find((a) => a.type === "array");
      if (alts.length && !array) {
        throw new Error(`${key} isn't a list; give it without [].`);
      }
      node[last] ??= [];
      if (!Array.isArray(node[last])) {
        throw new Error(`${key} is given as a list and as a value; give one or the other.`);
      }
      node[last].push(typed ? typedValue(value, array?.items, `${key}[]`, doc) : value);
    } else {
      if (Object.hasOwn(node, last)) {
        throw new Error(`${key} is given more than once; give it once, or as ${key}[] for a list.`);
      }
      node[last] = typed ? typedValue(value, schema, key, doc) : value;
    }
  }
  return { query, body };
}

/**
 * A refusal's body, readable: its code and message, the field it names, and its next move from
 * the document when there is one. Undefined when the body isn't a Kestrel refusal.
 */
export function describeRefusal(body, { doc, op } = {}) {
  if (!body || typeof body !== "object" || typeof body.error !== "string") {
    return undefined;
  }
  const lines = [`${body.error}: ${body.message ?? ""}`.trim()];
  if (typeof body.field === "string") {
    lines.push(`field: ${body.field}`);
  }
  if (typeof body.retry_after === "number") {
    lines.push(`retry after: ${new Date(body.retry_after).toISOString()}`);
  }
  const move = doc ? nextMove(doc, body.error, op) : undefined;
  if (move) {
    lines.push(`next move: ${move}.`);
  }
  return lines;
}
