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

import { unwrap } from "./unwrap";

export type SortDir = "asc" | "desc";

/**
 * A list endpoint's sort contract: the public sort keys mapped to the SQL column
 * (or expression) they order by, plus the defaults. `columns` is the whitelist — a
 * `sort` outside it falls back to `defaultSort`, so untrusted input never reaches
 * the ORDER BY. Values are code-defined, which is what makes interpolating the
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

/** The pagination envelope attached to every list response. */
export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  sort: string;
  dir: SortDir;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseListParams(url: URL, spec: ListSpec): ListParams {
  const sortParam = url.searchParams.get("sort") ?? "";
  const sortExplicit = sortParam !== "" && sortParam in spec.columns;
  const sort = sortExplicit ? sortParam : spec.defaultSort;
  // `sort` is either a validated key or `defaultSort`; a spec whose defaultSort isn't a
  // real column is a programming error, so fail loud rather than emit `ORDER BY undefined`.
  const column = unwrap(spec.columns[sort], "list sort column");

  const dirParam = url.searchParams.get("dir");
  const dir: SortDir = dirParam === "asc" || dirParam === "desc" ? dirParam : spec.defaultDir;

  const limit = clampInt(
    url.searchParams.get("limit"),
    spec.defaultLimit ?? DEFAULT_LIMIT,
    1,
    spec.maxLimit ?? MAX_LIMIT,
  );
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

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

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}
