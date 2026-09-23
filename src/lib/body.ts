/**
 * The one reader for JSON request bodies, and the field readers over what it returns.
 *
 * One rule: a wrong shape is a 400 that names the problem, and nothing is dropped or
 * defaulted. A body that is absent, not JSON, or JSON but not an object (`null`, an
 * array, a string) is refused before any route reads a field from it; a field that is
 * present with the wrong type is refused with its name, both in the message and as the
 * error body's `field` key, so a client learns what to fix instead of getting a 200
 * that quietly ignored it. Absent optional fields stay absent. The domain rules above
 * this layer (a valid email, `fire_at` far enough out, a template with an unsubscribe
 * link) stay with their routes.
 */

import type { RequestContext } from "../router";
import { badRequest } from "./errors";

/** A parsed JSON body (or a nested object within one): known to be a plain object. */
export type JsonObject = Record<string, unknown>;

/** A 400 that names the offending field, in the message and as `field` on the error body. */
export function fieldError(field: string, message: string) {
  return badRequest(message, { field });
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the request body as a JSON object, or throw a 400 naming what is wrong with it.
 * `optional` lets an empty body stand for `{}`, for the routes that have a sensible
 * default when nothing is sent; a body that is present must still be a JSON object.
 */
export async function readJsonObject(
  c: RequestContext,
  opts: { optional?: boolean } = {},
): Promise<JsonObject> {
  const text = await c.req.text();
  if (text.trim() === "") {
    if (opts.optional) {
      return {};
    }
    throw badRequest("a JSON body is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("the body is not valid JSON");
  }
  if (!isObject(parsed)) {
    const what = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw badRequest(`the body must be a JSON object, not ${what}`);
  }
  return parsed;
}

// A nested reader passes its parent's path, so the name a refusal carries is the full
// one (`publication.name`), the same the client would use to find the input.
function path(key: string, at?: string): string {
  return at ? `${at}.${key}` : key;
}

/** An optional string field: absent is `undefined`; present and not a string is a 400. */
export function optString(o: JsonObject, key: string, at?: string): string | undefined {
  const v = o[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "string") {
    throw fieldError(path(key, at), `${path(key, at)} must be a string`);
  }
  return v;
}

/** An optional string field that also accepts `null`, for a field where null means "none". */
export function optStringOrNull(
  o: JsonObject,
  key: string,
  at?: string,
): string | null | undefined {
  const v = o[key];
  if (v === undefined || v === null || typeof v === "string") {
    return v;
  }
  throw fieldError(path(key, at), `${path(key, at)} must be a string or null`);
}

/** An optional list of strings: absent is `undefined`; anything else but a string array is a 400. */
export function optStringList(o: JsonObject, key: string, at?: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) {
    throw fieldError(path(key, at), `${path(key, at)} must be a list of strings`);
  }
  return v;
}

/** An optional nested object: absent is `undefined`; present and not an object is a 400. */
export function optObject(o: JsonObject, key: string, at?: string): JsonObject | undefined {
  const v = o[key];
  if (v === undefined) {
    return undefined;
  }
  if (!isObject(v)) {
    throw fieldError(path(key, at), `${path(key, at)} must be an object`);
  }
  return v;
}

/** A required field that must be one of a fixed set of strings; anything else is a 400 listing them. */
export function oneOf<const T extends string>(
  o: JsonObject,
  key: string,
  allowed: readonly T[],
  at?: string,
): T {
  const v = o[key];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  const list = allowed.map((a) => `'${a}'`).join(" or ");
  throw fieldError(path(key, at), `${path(key, at)} must be ${list}`);
}
