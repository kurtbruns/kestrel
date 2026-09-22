// Shared list controls: the query model, toolbar, sortable headers, and pager.

import type { PageMeta, SortDir } from "../shared/list";
import { type Html, html, setHtml } from "./html";

// One convention for the admin list views (Posts, Subscribers, Sends): a search-left
// / filters-right toolbar, clickable sortable column headers, and offset pagination —
// all driven by a small per-view `state` object whose reload() rebuilds the query and
// re-fetches. The hash only seeds the initial filter (dashboard deep-links); sort,
// page, and filter operate in place, matching the `page` envelope the endpoints return
// (shared/list.ts).

/** The per-view list state every control reads and writes. */
export interface ListState {
  status?: string;
  search?: string;
  sort?: string;
  dir?: SortDir;
  /** "only" narrows to suppressed subscribers; a deliverability axis, independent of status. */
  suppressed?: "" | "only";
  /** "only" narrows to sends with delivery failures. */
  failures?: "" | "only";
  offset: number;
  limit: number;
}

/** What a list toolbar offers; see listToolbar for what each field means. */
export interface ToolbarConfig {
  statuses?: { value: string; label: string }[];
  allValue?: string;
  searchPlaceholder?: string;
  suppressible?: boolean;
  failures?: boolean;
}

/**
 * Build the query string for a list request from the view state. `sort`/`dir` are sent
 * only once a column is chosen (state.sort set), so a view keeps its endpoint's bespoke
 * default order (e.g. posts' scheduled-first) until the reader sorts.
 */
export function listQuery(state: ListState): string {
  const p = new URLSearchParams();
  if (state.status) {
    p.set("status", state.status);
  }
  if (state.suppressed) {
    p.set("suppressed", state.suppressed);
  }
  if (state.failures) {
    p.set("failures", state.failures);
  }
  const term = (state.search || "").trim();
  if (term) {
    p.set("search", term);
  }
  if (state.sort) {
    p.set("sort", state.sort);
    p.set("dir", state.dir ?? "desc");
  }
  p.set("limit", String(state.limit));
  p.set("offset", String(state.offset));
  return p.toString();
}

/**
 * A filter/search toolbar: search on the left, the status filter pinned right.
 * `cfg.statuses` = [{value,label}]. `cfg.suppressible` (subscribers only) adds a
 * separate "Suppressed only" toggle — suppression is a deliverability flag, not a
 * consent status, so it's its own control (an independent axis you can combine with a
 * status), never an option inside the status dropdown.
 * `cfg.allValue` sets what the "All statuses" option means — normally "" (no status
 * filter), but the Drafts view passes "draft,scheduled" so "All" stays scoped to the
 * two draft-side statuses rather than reaching sent posts. Omit `cfg.statuses` for a
 * search-only toolbar (the Sent list is single-status, so it carries no status filter).
 * `cfg.failures` adds the Sent list's "With delivery failures" flag — a filter, not a sort: it keeps
 * the newest-first order the operator scans by and needs no severity weighting (a summed
 * sort would rank 25 retried unsent recipients above one spam complaint).
 */
export function listToolbar(cfg: ToolbarConfig): Html {
  const statusSel = cfg.statuses?.length
    ? html`<select class="lt-status" aria-label="Filter by status"><option value="${cfg.allValue || ""}">All statuses</option>${cfg.statuses.map(
        (s) => html`<option value="${s.value}">${s.label}</option>`,
      )}</select>`
    : null;
  const suppressed = cfg.suppressible
    ? html`<label class="lt-toggle"><input type="checkbox" class="lt-suppressed"><span>Suppressed</span></label>`
    : null;
  const failures = cfg.failures
    ? html`<label class="lt-toggle"><input type="checkbox" class="lt-failures"><span>With delivery failures</span></label>`
    : null;
  return html`<div class="list-toolbar">
    <input class="lt-search" type="search" placeholder="${cfg.searchPlaceholder || "Search…"}" aria-label="Search" autocomplete="off">
    <div class="lt-filters">${statusSel}${suppressed}${failures}</div>
  </div>`;
}

/**
 * Wire the toolbar controls (within `root`) to the view's reload, seeding their values
 * from state so a deep-linked filter shows selected. Search is debounced; any change
 * resets to the first page. Status and the suppression toggle are independent axes.
 */
export function wireToolbar(root: ParentNode, state: ListState, reload: () => void): void {
  const search = root.querySelector<HTMLInputElement>(".lt-search");
  const status = root.querySelector<HTMLSelectElement>(".lt-status");
  const suppressed = root.querySelector<HTMLInputElement>(".lt-suppressed");
  const failures = root.querySelector<HTMLInputElement>(".lt-failures");
  if (search) {
    search.value = state.search || "";
    let t: number | undefined;
    search.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.search = search.value;
        state.offset = 0;
        reload();
      }, 250);
    };
  }
  if (status) {
    status.value = state.status || "";
    status.onchange = () => {
      state.status = status.value;
      state.offset = 0;
      reload();
    };
  }
  if (suppressed) {
    suppressed.checked = state.suppressed === "only";
    suppressed.onchange = () => {
      state.suppressed = suppressed.checked ? "only" : "";
      state.offset = 0;
      reload();
    };
  }
  if (failures) {
    failures.checked = state.failures === "only";
    failures.onchange = () => {
      state.failures = failures.checked ? "only" : "";
      state.offset = 0;
      reload();
    };
  }
}

/**
 * A table header cell. A sortable column (given a `key`) renders a button that toggles
 * asc/desc and shows the active direction; other columns are plain labels. `cls` adds a
 * column class (e.g. "num" for right-aligned numeric columns).
 */
export function th(label: string, key: string | null, state: ListState, cls?: string): Html {
  if (!key) {
    return cls ? html`<th class="${cls}">${label}</th>` : html`<th>${label}</th>`;
  }
  const active = state.sort === key;
  // A fixed-width slot always reserved (empty when unsorted) so the label doesn't
  // shift when the arrow appears; light ↑/↓ to match the app's other arrows.
  const arrow = active ? (state.dir === "asc" ? "↑" : "↓") : "";
  const klass = `${cls ? `${cls} ` : ""}sortable${active ? " sorted" : ""}`;
  return html`<th class="${klass}"><button type="button" class="th-sort" data-sort="${key}">${label}<span class="th-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

/**
 * Wire the sortable headers inside a freshly-rendered table. Clicking a column sorts by
 * it (default desc), or flips direction if it is already the sort key; resets to page 1.
 */
export function wireSort(container: ParentNode, state: ListState, reload: () => void): void {
  for (const b of container.querySelectorAll<HTMLButtonElement>(".th-sort")) {
    b.onclick = () => {
      const key = b.dataset.sort;
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "desc";
      }
      state.offset = 0;
      reload();
    };
  }
}

/**
 * Offset pager: "a–b of N" with Prev/Next. Renders nothing when one page covers all.
 */
export function renderPager(
  el: Element,
  state: ListState,
  page: PageMeta | null | undefined,
  reload: () => void,
): void {
  // Page by the limit the server actually clamped to (page.limit), not the requested one.
  const limit = page?.limit ?? state.limit;
  if (!page || page.total <= limit) {
    setHtml(el, html``);
    return;
  }
  const from = page.offset + 1;
  const to = Math.min(page.offset + limit, page.total);
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + limit < page.total;
  setHtml(
    el,
    html`<div class="pager"><button type="button" class="pager-prev"${hasPrev ? null : DISABLED}>← Prev</button><span class="pager-range muted">${from}–${to} of ${page.total}</span><button type="button" class="pager-next"${hasNext ? null : DISABLED}>Next →</button></div>`,
  );
  if (hasPrev) {
    const prev = el.querySelector<HTMLButtonElement>(".pager-prev");
    if (prev) {
      prev.onclick = () => {
        state.offset = Math.max(0, page.offset - limit);
        reload();
      };
    }
  }
  if (hasNext) {
    const next = el.querySelector<HTMLButtonElement>(".pager-next");
    if (next) {
      next.onclick = () => {
        state.offset = page.offset + limit;
        reload();
      };
    }
  }
}

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
const DISABLED = html` disabled`;
