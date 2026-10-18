/**
 * Strict at the door (API.md, principle 7): an admin request naming a query parameter, a
 * query value, or a body field its route doesn't declare is a 400 naming it, so a typo or a
 * stale name is never a success that quietly ignored it.
 *
 * Checked against the route's manifest entry, the same record the API reference is generated
 * from, so what the reference documents is exactly what a route takes. The router runs it
 * after the gate and before the handler, for the admin tier only: a webhook's body is the
 * provider's to shape, and a reader's link carries whatever a mail client adds to it.
 *
 * Only what can be read is checked here. A body that is empty, not JSON, or not an object is
 * left to its reader (`readJsonObject`), which refuses it in its own words.
 */

import type { BodyField, QueryParam } from "../../shared/reference";
import { fieldError, type JsonObject, mediaTypeOf } from "./body";

/** The keys a body may carry at one level, each with the keys declared beneath it. */
type KeyTree = Map<string, KeyTree>;

/** The declared fields as a tree: a dotted name (`publication.name`) declares a nested key. */
function keyTree(fields: readonly BodyField[]): KeyTree {
  const root: KeyTree = new Map();
  for (const field of fields) {
    let node = root;
    for (const part of field.name.split(".")) {
      let next = node.get(part);
      if (next === undefined) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
  }
  return root;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The refusal of a field this route doesn't take, listing the ones it does at that level. */
function unknownField(name: string, known: readonly string[]) {
  const takes = known.length === 0 ? "none" : known.map((k) => `'${k}'`).join(", ");
  return fieldError(name, `${name} isn’t a field this takes; it takes ${takes}`);
}

/** Refuse the first key at any declared level that the tree doesn't name. A key with no
 *  fields declared beneath it is a leaf, whatever its value holds. */
function refuseUnknownKeys(o: JsonObject, tree: KeyTree, at?: string): void {
  for (const [key, value] of Object.entries(o)) {
    const name = at ? `${at}.${key}` : key;
    const below = tree.get(key);
    if (below === undefined) {
      throw unknownField(name, [...tree.keys()]);
    }
    if (below.size > 0 && isObject(value)) {
      refuseUnknownKeys(value, below, name);
    }
  }
}

/** A query value's refusal, worded by how many values the parameter takes. */
function valueMessage(name: string, values: readonly string[], list: boolean): string {
  if (list) {
    return `${name} must be one or more of ${values.join(", ")}, comma-separated`;
  }
  if (values.length === 1) {
    return `${name} must be ${values[0]}`;
  }
  if (values.length === 2) {
    return `${name} must be ${values[0]} or ${values[1]}`;
  }
  return `${name} must be one of ${values.join(", ")}`;
}

/** Refuse a query parameter the route doesn't declare, and a value outside the ones it does. */
export function refuseUndeclaredQuery(url: URL, declared: readonly QueryParam[]): void {
  for (const name of new Set(url.searchParams.keys())) {
    const param = declared.find((p) => p.name === name);
    if (param === undefined) {
      const takes = declared.length === 0 ? "none" : declared.map((p) => `'${p.name}'`).join(", ");
      throw fieldError(name, `${name} isn’t a query parameter this takes; it takes ${takes}`);
    }
    const values = param.values;
    if (values === undefined) {
      continue;
    }
    for (const raw of url.searchParams.getAll(name)) {
      const parts = param.list ? raw.split(",").map((s) => s.trim()) : [raw];
      if (parts.some((v) => !values.includes(v))) {
        throw fieldError(name, valueMessage(name, values, param.list === true));
      }
    }
  }
}

/**
 * Refuse a body field the route doesn't declare: a JSON object's keys, at every level the
 * route declares nested fields for, or a form's field names. Read from a clone, so the
 * handler still reads the body itself.
 */
export async function refuseUndeclaredBody(
  req: Request,
  accepts: readonly string[],
  fields: readonly BodyField[],
): Promise<void> {
  const type = mediaTypeOf(req);
  if (type === undefined || !accepts.includes(type)) {
    return;
  }
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await req.clone().text());
    } catch {
      return;
    }
    if (isObject(parsed)) {
      refuseUnknownKeys(parsed, keyTree(fields));
    }
    return;
  }
  if (type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await req.clone().formData();
    } catch {
      return;
    }
    const known = fields.map((f) => f.name);
    for (const name of new Set(form.keys())) {
      if (!known.includes(name)) {
        throw unknownField(name, known);
      }
    }
  }
}
