// The list envelope both clients read: the pagination metadata every list response carries
// (SPEC §4 lists are offset-paged), typed once so the editor's pager and the Worker's
// responses can never disagree about it.

/** A list's sort directions, which its `dir` takes. */
export const SORT_DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/** The pagination envelope attached to every list response. */
export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  sort: string;
  dir: SortDir;
}
