/**
 * Shared list-query convention for the admin list endpoints (subscribers, posts,
 * sends). One place parses and validates `sort` / `dir` / `limit` / `offset`,
 * whitelists the sortable columns per endpoint, and shapes the `page` envelope
 * every list response carries — so the three lists behave identically and their
 * SQL stays free of ad-hoc param plumbing.
 *
 * Pagination is offset + total (not keyset): at newsletter scale COUNT is cheap and
 * offset supports arbitrary, nullable sort columns and a plain prev/next UI. Keyset
 * is the scale-up path if a list ever grows large.
 */

import type { PageMeta, SortDir } from "../../shared/list";
import { badRequest } from "./errors";
import { unwrap } from "./unwrap";

// The envelope's types live in shared/ so the editor reads the same definition; re-exported
// here so the Worker's list code keeps one import for the whole model.
export type { PageMeta, SortDir };

/**
 * A list endpoint's sort contract: the public sort keys mapped to the SQL column
 * (or expression) they order by, plus the defaults. `columns` is the whitelist — a
 * `sort` outside it is a 400, so untrusted input never reaches the ORDER BY. Values are code-defined, which is what makes interpolating the
 * resolved column into SQL safe.
 */
export interface ListSpec {
  columns: Record<string, string>;
  defaultSort: string;
  defaultDir: SortDir;
  defaultLimit?: number;
  maxLimit?: number;
}

/** The validated, ready-to-use list query for one request. */
export interface ListParams {
  /** The validated public sort key (echoed back in the `page` envelope). */
  sort: string;
  /** The SQL column/expression `sort` resolved to (whitelisted; safe to interpolate). */
  column: string;
  dir: SortDir;
  limit: number;
  offset: number;
  /** Whether the request supplied a valid `sort` (vs. falling back to the default) —
   *  lets an endpoint keep a bespoke default ordering until the reader picks a column. */
  sortExplicit: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseListParams(url: URL, spec: ListSpec): ListParams {
  const sortParam = url.searchParams.get("sort");
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `sort=constructor`
  // / `toString` / etc. would pass the whitelist and resolve to an inherited function,
  // which then interpolates into the ORDER BY as malformed SQL. Own keys only; any other
  // value is refused naming the field, never quietly read as the default.
  if (sortParam !== null && !Object.hasOwn(spec.columns, sortParam)) {
    throw badRequest(`sort must be one of ${Object.keys(spec.columns).join(", ")}`, {
      field: "sort",
    });
  }
  const sortExplicit = sortParam !== null;
  const sort = sortParam ?? spec.defaultSort;
  // `sort` is either a validated key or `defaultSort`; a spec whose defaultSort isn't a
  // real column is a programming error, so fail loud rather than emit `ORDER BY undefined`.
  const column = unwrap(spec.columns[sort], "list sort column");

  const dirParam = url.searchParams.get("dir");
  if (dirParam !== null && dirParam !== "asc" && dirParam !== "desc") {
    throw badRequest("dir must be asc or desc", { field: "dir" });
  }
  const dir: SortDir = dirParam ?? spec.defaultDir;

  const limit = clampInt(
    "limit",
    url.searchParams.get("limit"),
    spec.defaultLimit ?? DEFAULT_LIMIT,
    1,
    spec.maxLimit ?? MAX_LIMIT,
  );
  const offset = clampInt("offset", url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  return { sort, column, dir, limit, offset, sortExplicit };
}

/**
 * The `ORDER BY` for a list query, with a stable secondary key so offset paging is
 * deterministic when the primary sort column ties. `tiebreak` must be a code-defined
 * column (a unique key like the row id), never user input.
 */
export function orderByClause(params: ListParams, tiebreak: string): string {
  const dir = params.dir === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${params.column} ${dir}, ${tiebreak} ${dir}`;
}

export function listPage(total: number, params: ListParams): PageMeta {
  return {
    total,
    limit: params.limit,
    offset: params.offset,
    sort: params.sort,
    dir: params.dir,
  };
}

/** A whole-number query value, held to its range (a documented clamp, such as the page
 *  size's maximum); one that is not a whole number is a 400 naming the field. */
function clampInt(
  field: string,
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) {
    return fallback;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw badRequest(`${field} must be a whole number`, { field });
  }
  const n = Number.parseInt(raw, 10);
  return Math.min(Math.max(n, min), max);
}
