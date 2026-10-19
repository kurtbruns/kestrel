/**
 * Strict at the door (docs/API.md principle 7): an API route takes only what its manifest
 * entry declares. A query parameter it doesn't list, a value outside a parameter's
 * declared `values`, or a body key that isn't one of its `body` fields is refused with a
 * 400 naming it, before the handler runs, so a misnamed field or a stray filter is never
 * answered with a success that ignored it. A route gets both checks by declaring its
 * parameters and fields, with nothing to remember in its handler.
 *
 * What a value must look like beyond a fixed set (a whole number, a cursor, an address) and
 * a field's type stay with the route's own readers (`src/lib/body.ts`, `src/lib/list.ts`).
 * A body that isn't a JSON object or a form passes through to its reader, which says what
 * is wrong with it.
 */

import type { BodyField, QueryParam } from "../../shared/reference";
import type { Middleware, RequestContext } from "../router";
import { bodyJson, fieldError, type JsonObject, mediaTypeOf, readForm } from "./body";

/** A route's declared body fields as a tree: a dotted name (`publication.name`) nests. */
interface FieldTree {
  [key: string]: FieldTree;
}

function fieldTree(fields: readonly BodyField[]): FieldTree {
  const tree: FieldTree = {};
  for (const { name } of fields) {
    let node = tree;
    for (const part of name.split(".")) {
      node[part] ??= {};
      node = node[part];
    }
  }
  return tree;
}

/** What a refusal says the route takes instead: the names it declares, or none. */
function takes(names: readonly string[]): string {
  return names.length ? `it takes ${names.map((n) => `'${n}'`).join(", ")}` : "it takes none";
}

/** Refuse the first key the body holds that its declared fields don't, at any depth. A field
 *  declared without children is the route's to read whole (a list, a string), so the walk
 *  stops there. */
function refuseUnknownKeys(o: JsonObject, tree: FieldTree, at?: string): void {
  const known = Object.keys(tree);
  for (const [key, value] of Object.entries(o)) {
    const path = at ? `${at}.${key}` : key;
    const node = Object.hasOwn(tree, key) ? tree[key] : undefined;
    if (node === undefined) {
      throw fieldError(path, `${path} isn’t a field this takes; ${takes(known)}`);
    }
    if (Object.keys(node).length > 0 && typeof value === "object" && value !== null) {
      if (!Array.isArray(value)) {
        refuseUnknownKeys(value as JsonObject, node, path);
      }
    }
  }
}

function refuseUnknownQuery(url: URL, declared: readonly QueryParam[]): void {
  const names = declared.map((q) => q.name);
  for (const name of new Set(url.searchParams.keys())) {
    const param = declared.find((q) => q.name === name);
    if (!param) {
      throw fieldError(name, `${name} isn’t a query parameter this takes; ${takes(names)}`);
    }
    const given = url.searchParams.getAll(name);
    if (given.length > 1) {
      throw fieldError(name, `${name} is given more than once; give it once`);
    }
    const { values } = param;
    if (values) {
      const raw = given[0] ?? "";
      const parts = param.list ? raw.split(",").map((v) => v.trim()) : [raw];
      if (parts.some((v) => !values.includes(v))) {
        throw fieldError(
          name,
          param.list
            ? `${name} must be one or more of ${values.join(", ")}, comma-separated`
            : `${name} must be one of ${values.join(", ")}`,
        );
      }
    }
  }
}

/**
 * The check for one route, from what it declares. The body is read once and held for the
 * route's own reader (`bodyJson`, `readForm`); a raw upload's bytes have no keys to check.
 */
export function refuseUndeclared(def: {
  query?: readonly QueryParam[];
  body?: readonly BodyField[];
}): Middleware {
  const declaredQuery = def.query ?? [];
  const tree = fieldTree(def.body ?? []);
  return async (c: RequestContext) => {
    refuseUnknownQuery(c.url, declaredQuery);
    if (c.req.body === null) {
      return undefined;
    }
    const type = mediaTypeOf(c.req);
    if (type === "application/json") {
      const o = await bodyJson(c.req);
      if (o) {
        refuseUnknownKeys(o, tree);
      }
    } else if (type === "multipart/form-data") {
      // A form the runtime can't parse is its route's to refuse, as it was before this check.
      const form = await readForm(c.req).catch(() => undefined);
      for (const key of new Set(form?.keys() ?? [])) {
        if (!Object.hasOwn(tree, key)) {
          throw fieldError(key, `${key} isn’t a field this takes; ${takes(Object.keys(tree))}`);
        }
      }
    }
    return undefined;
  };
}
