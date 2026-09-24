import { describe, expect, it, vi } from "vitest";
import { html, setHtml } from "./html";
import {
  type ListState,
  listQuery,
  listToolbar,
  renderPager,
  th,
  wireSort,
  wireToolbar,
} from "./list_controls";

const base = (over: Partial<ListState> = {}): ListState => ({ offset: 0, limit: 50, ...over });

describe("listQuery", () => {
  it("sends sort and dir only once a column is chosen, and trims the search", () => {
    expect(listQuery(base({ search: "  robins " }))).toBe("search=robins&limit=50&offset=0");
    expect(listQuery(base({ sort: "subject", dir: "asc", status: "draft" }))).toBe(
      "status=draft&sort=subject&dir=asc&limit=50&offset=0",
    );
  });

  it("sends dir=desc when a column is chosen without a direction", () => {
    expect(listQuery(base({ sort: "subject" }))).toBe("sort=subject&dir=desc&limit=50&offset=0");
  });

  it("carries the two independent axes as their own params", () => {
    expect(listQuery(base({ suppressed: "only", failures: "only" }))).toBe(
      "suppressed=only&failures=only&limit=50&offset=0",
    );
  });
});

describe("listToolbar", () => {
  it("escapes labels and the placeholder, and renders only the controls asked for", () => {
    const m = listToolbar({
      statuses: [{ value: "draft", label: "Draft & <new>" }],
      allValue: "draft,scheduled",
      searchPlaceholder: `Search "posts"`,
    }).markup;
    expect(m).toContain(`<option value="draft,scheduled">All statuses</option>`);
    expect(m).toContain(`<option value="draft">Draft &amp; &lt;new&gt;</option>`);
    expect(m).toContain(`placeholder="Search &quot;posts&quot;"`);
    expect(m).not.toContain("lt-suppressed");
    expect(listToolbar({ suppressible: true, failures: true }).markup).toMatch(
      /lt-suppressed[\s\S]*lt-failures/,
    );
    expect(listToolbar({}).markup).not.toContain("<select");
  });
});

describe("wireToolbar", () => {
  it("seeds the controls from state and reloads from page one on a change", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    setHtml(
      root,
      listToolbar({ statuses: [{ value: "draft", label: "Draft" }], suppressible: true }),
    );
    const state = base({ search: "owls", status: "draft", offset: 100 });
    const reload = vi.fn();
    wireToolbar(root, state, reload);
    const search = root.querySelector<HTMLInputElement>(".lt-search")!;
    expect(search.value).toBe("owls");
    expect(root.querySelector<HTMLSelectElement>(".lt-status")!.value).toBe("draft");
    search.value = "hawks";
    search.oninput?.(new Event("input"));
    expect(reload).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(260);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ search: "hawks", offset: 0 });
    const sup = root.querySelector<HTMLSelectElement>(".lt-suppressed")!;
    expect(sup.value).toBe("");
    sup.value = "only";
    sup.onchange?.(new Event("change"));
    expect(state.suppressed).toBe("only");
    sup.value = "hide";
    sup.onchange?.(new Event("change"));
    expect(state.suppressed).toBe("hide");
    vi.useRealTimers();
  });

  it("coalesces a burst of typing into one reload, and wires status and failures too", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    setHtml(root, listToolbar({ statuses: [{ value: "draft", label: "Draft" }], failures: true }));
    const state = base({ offset: 75 });
    const reload = vi.fn();
    wireToolbar(root, state, reload);
    const search = root.querySelector<HTMLInputElement>(".lt-search")!;
    for (const v of ["h", "ha", "haw"]) {
      search.value = v;
      search.oninput?.(new Event("input"));
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(300);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(state.search).toBe("haw");
    const status = root.querySelector<HTMLSelectElement>(".lt-status")!;
    status.value = "draft";
    status.onchange?.(new Event("change"));
    expect(state).toMatchObject({ status: "draft", offset: 0 });
    const failures = root.querySelector<HTMLInputElement>(".lt-failures")!;
    failures.checked = true;
    failures.onchange?.(new Event("change"));
    expect(state.failures).toBe("only");
    expect(reload).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("th + wireSort", () => {
  it("renders a plain cell without a key and a sort button with one, showing the active direction", () => {
    expect(th("Subject", null, base()).markup).toBe("<th>Subject</th>");
    expect(th("Count", null, base(), "num").markup).toBe(`<th class="num">Count</th>`);
    const sorted = th("Subject", "subject", base({ sort: "subject", dir: "asc" })).markup;
    expect(sorted).toContain(`class="sortable sorted"`);
    expect(sorted).toContain(`data-sort="subject"`);
    expect(sorted).toContain("↑");
    expect(th("<b>", "b", base()).markup).toContain("&lt;b&gt;");
    expect(th("Count", "count", base({ sort: "count", dir: "desc" }), "num").markup).toContain(
      `class="num sortable sorted"`,
    );
  });

  it("sorts desc first, flips on the same column, and resets to page one", () => {
    const table = document.createElement("table");
    const state = base({ offset: 50 });
    setHtml(table, html`<tr>${th("Subject", "subject", state)}</tr>`);
    const reload = vi.fn();
    wireSort(table, state, reload);
    const btn = table.querySelector<HTMLButtonElement>(".th-sort")!;
    btn.click();
    expect(state).toMatchObject({ sort: "subject", dir: "desc", offset: 0 });
    btn.click();
    expect(state.dir).toBe("asc");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("switching to another column starts that column desc", () => {
    const table = document.createElement("table");
    const state = base({ sort: "subject", dir: "asc" });
    setHtml(table, html`<tr>${th("Subject", "subject", state)}${th("Date", "date", state)}</tr>`);
    wireSort(table, state, vi.fn());
    table.querySelectorAll<HTMLButtonElement>(".th-sort")[1]!.click();
    expect(state).toMatchObject({ sort: "date", dir: "desc" });
  });
});

describe("renderPager", () => {
  const page = (total: number, offset: number, limit = 50) =>
    ({ total, offset, limit, sort: "", dir: "desc" }) as const;

  it("renders nothing when one page covers everything", () => {
    const el = document.createElement("div");
    renderPager(el, base(), page(50, 0), vi.fn());
    expect(el.innerHTML).toBe("");
    renderPager(el, base(), null, vi.fn());
    expect(el.innerHTML).toBe("");
  });

  it("shows the range by the server's limit and moves by it, disabling the edge buttons", () => {
    const el = document.createElement("div");
    const state = base({ limit: 50 });
    const reload = vi.fn();
    renderPager(el, state, page(120, 25, 25), reload); // the server clamped to 25
    expect(el.textContent).toContain("26–50 of 120");
    const prev = el.querySelector<HTMLButtonElement>(".pager-prev")!;
    const next = el.querySelector<HTMLButtonElement>(".pager-next")!;
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    next.click();
    expect(state.offset).toBe(50);
    expect(reload).toHaveBeenCalledTimes(1);
    renderPager(el, state, page(120, 0, 25), reload);
    expect(el.querySelector<HTMLButtonElement>(".pager-prev")!.disabled).toBe(true);
  });
});
