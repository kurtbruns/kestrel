// @ts-nocheck
// Shared list controls: the query model, toolbar, sortable headers, and pager.

import { esc } from "./helpers";

// One convention for the admin list views (Posts, Subscribers, Sends): a search-left
// / filters-right toolbar, clickable sortable column headers, and offset pagination —
// all driven by a small per-view `state` object whose reload() rebuilds the query and
// re-fetches. The hash only seeds the initial filter (dashboard deep-links); sort,
// page, and filter operate in place, matching the `page` envelope the endpoints return
// (see src/lib/list.ts).

// Build the query string for a list request from the view state. `sort`/`dir` are sent
// only once a column is chosen (state.sort set), so a view keeps its endpoint's bespoke
// default order (e.g. posts' scheduled-first) until the reader sorts.
export function listQuery(state) {
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
    p.set("dir", state.dir);
  }
  p.set("limit", String(state.limit));
  p.set("offset", String(state.offset));
  return p.toString();
}

// A filter/search toolbar: search on the left, the status filter pinned right.
// `cfg.statuses` = [{value,label}]. `cfg.suppressible` (subscribers only) adds a
// separate "Suppressed only" toggle — suppression is a deliverability flag, not a
// consent status, so it's its own control (an independent axis you can combine with a
// status), never an option inside the status dropdown.
// `cfg.allValue` sets what the "All statuses" option means — normally "" (no status
// filter), but the Drafts view passes "draft,scheduled" so "All" stays scoped to the
// two draft-side statuses rather than reaching sent posts. Omit `cfg.statuses` for a
// search-only toolbar (the Sent list is single-status, so it carries no status filter).
// `cfg.failures` adds the Sent list's "With delivery failures" flag — a filter, not a sort: it keeps
// the newest-first order the operator scans by and needs no severity weighting (a summed
// sort would rank 25 retried unsent recipients above one spam complaint).
export function listToolbar(cfg) {
  const statusSel = cfg.statuses?.length
    ? `<select class="lt-status" aria-label="Filter by status">${[
        `<option value="${esc(cfg.allValue || "")}">All statuses</option>`,
      ]
        .concat(cfg.statuses.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`))
        .join("")}</select>`
    : "";
  const suppressed = cfg.suppressible
    ? '<label class="lt-toggle"><input type="checkbox" class="lt-suppressed"><span>Suppressed</span></label>'
    : "";
  const failures = cfg.failures
    ? '<label class="lt-toggle"><input type="checkbox" class="lt-failures"><span>With delivery failures</span></label>'
    : "";
  return `<div class="list-toolbar">
    <input class="lt-search" type="search" placeholder="${esc(cfg.searchPlaceholder || "Search…")}" aria-label="Search" autocomplete="off">
    <div class="lt-filters">${statusSel}${suppressed}${failures}</div>
  </div>`;
}

// Wire the toolbar controls (within `root`) to the view's reload, seeding their values
// from state so a deep-linked filter shows selected. Search is debounced; any change
// resets to the first page. Status and the suppression toggle are independent axes.
export function wireToolbar(root, state, reload) {
  const search = root.querySelector(".lt-search");
  const status = root.querySelector(".lt-status");
  const suppressed = root.querySelector(".lt-suppressed");
  const failures = root.querySelector(".lt-failures");
  if (search) {
    search.value = state.search || "";
    let t = null;
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

// A table header cell. A sortable column (given a `key`) renders a button that toggles
// asc/desc and shows the active direction; other columns are plain labels. `cls` adds a
// column class (e.g. "num" for right-aligned numeric columns).
export function th(label, key, state, cls) {
  const c = cls ? ` class="${cls}"` : "";
  if (!key) {
    return `<th${c}>${esc(label)}</th>`;
  }
  const active = state.sort === key;
  // A fixed-width slot always reserved (empty when unsorted) so the label doesn't
  // shift when the arrow appears; light ↑/↓ to match the app's other arrows.
  const arrow = active ? (state.dir === "asc" ? "↑" : "↓") : "";
  const klass = `${cls ? `${cls} ` : ""}sortable${active ? " sorted" : ""}`;
  return `<th class="${klass}"><button type="button" class="th-sort" data-sort="${key}">${esc(label)}<span class="th-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

// Wire the sortable headers inside a freshly-rendered table. Clicking a column sorts by
// it (default desc), or flips direction if it is already the sort key; resets to page 1.
export function wireSort(container, state, reload) {
  container.querySelectorAll(".th-sort").forEach((b) => {
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
  });
}

// Offset pager: "a–b of N" with Prev/Next. Renders nothing when one page covers all.
export function renderPager(el, state, page, reload) {
  // Page by the limit the server actually clamped to (page.limit), not the requested one.
  const limit = page?.limit ?? state.limit;
  if (!page || page.total <= limit) {
    el.innerHTML = "";
    return;
  }
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + limit, page.total);
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + limit < page.total;
  el.innerHTML = `<div class="pager"><button type="button" class="pager-prev"${hasPrev ? "" : " disabled"}>← Prev</button><span class="pager-range muted">${from}–${to} of ${page.total}</span><button type="button" class="pager-next"${hasNext ? "" : " disabled"}>Next →</button></div>`;
  if (hasPrev) {
    el.querySelector(".pager-prev").onclick = () => {
      state.offset = Math.max(0, page.offset - limit);
      reload();
    };
  }
  if (hasNext) {
    el.querySelector(".pager-next").onclick = () => {
      state.offset = page.offset + limit;
      reload();
    };
  }
}
