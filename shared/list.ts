// The list envelope both clients read: the pagination metadata every list response carries
// (SPEC §4 lists are offset-paged), typed once so the editor's pager and the Worker's
// responses can never disagree about it.

export type SortDir = "asc" | "desc";

/** The pagination envelope attached to every list response. */
export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  sort: string;
  dir: SortDir;
}
