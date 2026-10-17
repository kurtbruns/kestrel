// The API reference room, rendered from /api/reference.

import type {
  BodyField,
  QueryParam,
  ReferenceConcept,
  ReferenceEntry,
  ReferenceField,
  ReferenceGroup,
  ReferenceObject,
  ReferenceRefusalGroup,
  ReferenceResource,
  ReferenceResponse,
  ReferenceTable,
  RouteError,
  RouteReturns,
} from "../../shared/reference";
import { concretePath, routeAnchor } from "../../shared/reference";
import { api, describeError } from "../api";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { codeBlock, copyFace, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { highlightCurl, highlightJson } from "../ui/highlight";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { inline, prose } from "../ui/prose";
import { renderError } from "../ui/widgets";
import { curlCommand } from "./curl";
import { roomShell } from "./shell";

// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA renders
// it natively: a rail beside the page, which opens with what every route shares (the
// rules, the refusal codes, lists, following changes, and the objects routes return) and
// then lists each tier's routes, each one scannable row led by its name, a native
// <details>, that opens in place to its full documentation.

/** What a refusal code means, from the refusal table, for a route line that adds nothing. */
type Meanings = ReadonlyMap<string, string>;
function apiExample(label: string, value: unknown): Html | null {
  return value === undefined
    ? null
    : codeBlock(label, highlightJson(value), JSON.stringify(value, null, 2));
}
/** The route as a curl command on this instance, with the credential its tier needs. */
function apiCurl(r: ReferenceEntry): Html | null {
  const cmd = curlCommand(r, location.origin, appState.session?.auth.mode ?? "dev");
  return cmd === null ? null : codeBlock("curl", highlightCurl(cmd), cmd);
}
/** A name or code that may break only where its words join, after each `_`, `.`, or `/`. */
function breakable(name: string): Html {
  return html`${name.split(/(?<=[_./])/).map((part, i) => html`${i ? html`<wbr>` : null}${part}`)}`;
}
/**
 * A table's first cell: the name, then what sits under it (its type, or the fields a refusal
 * carries), so the second cell, the line on what it means, keeps the width.
 */
function nameCell(name: Html | string, under?: Html | string | null, required?: boolean): Html {
  return html`<td class="api-name"><code>${typeof name === "string" ? breakable(name) : name}</code>${required ? html` <span class="api-req">required</span>` : null}${under ? html`<span class="api-under">${under}</span>` : null}</td>`;
}
// Query params for a list route, rendered as a name→description table so the
// generated reference documents filter/sort/pagination from the registration.
function apiQueryHtml(query: QueryParam[] | undefined): Html | null {
  if (!query?.length) {
    return null;
  }
  const rows = query.map(
    (q) => html`<tr>${nameCell(q.name, null, q.required)}<td>${inline(q.description)}</td></tr>`,
  );
  return html`<div class="block"><div class="block-head"><span class="block-label">Query</span></div><table class="api-table"><tbody>${rows}</tbody></table></div>`;
}
// A route's body: the media types it takes, from the registration the router enforces them
// by, in the label, then its fields, each with its type and whether the request needs it.
function apiBodyHtml(
  body: BodyField[] | undefined,
  accepts: readonly string[] | undefined,
): Html | null {
  if (!body?.length) {
    return null;
  }
  const rows = body.map(
    (f) => html`<tr>${nameCell(f.name, f.type, f.required)}<td>${inline(f.description)}</td></tr>`,
  );
  const types = accepts?.length
    ? html` · ${accepts.map((t, i) => html`${i ? ", " : ""}<code>${t}</code>`)}`
    : null;
  return html`<div class="block"><div class="block-head"><span class="block-label">Body${types}</span></div><table class="api-table api-body"><tbody>${rows}</tbody></table></div>`;
}
// The refusals the route gives of its own, each with its status and the fields it carries,
// and when: the route's own words, or the code's meaning from the refusal table.
function apiErrorsHtml(errors: RouteError[] | undefined, meanings: Meanings): Html | null {
  if (!errors?.length) {
    return null;
  }
  const rows = errors.map(
    (e) =>
      html`<tr>${nameCell(
        html`<span class="api-status">${e.status}</span> ${breakable(e.code)}`,
        e.details?.length
          ? html`with ${e.details.map((d, i) => html`${i ? ", " : ""}<code>${d}</code>`)}`
          : null,
      )}<td>${inline(e.when ?? meanings.get(e.code) ?? "")}</td></tr>`,
  );
  return html`<div class="block"><div class="block-head"><span class="block-label">Refusals</span></div><table class="api-table api-errors"><tbody>${rows}</tbody></table></div>`;
}
// Fields with their types and one line each, an enum's values listed under its line.
function apiFieldsTable(fields: readonly ReferenceField[]): Html {
  const rows = fields.map(
    (f) =>
      html`<tr>${nameCell(f.name, f.type)}<td>${inline(f.description)}${
        f.values?.length
          ? html`<ul class="api-values">${f.values.map((v) => html`<li><code>${v.value}</code> ${inline(v.description)}</li>`)}</ul>`
          : null
      }</td></tr>`,
  );
  return html`<table class="api-table api-fields"><tbody>${rows}</tbody></table>`;
}
// What a route answers: the object it returns, linked to its section, and its own fields.
function apiReturnsHtml(
  r: RouteReturns | undefined,
  objects: ReadonlyMap<string, string>,
): Html | null {
  if (!r) {
    return null;
  }
  const link = r.object
    ? html`<a href="#/api-reference/objects-${r.object}" class="api-obj-link" data-sec="objects-${r.object}">${objects.get(r.object) ?? r.object}</a>`
    : null;
  const what = link
    ? r.as
      ? html`<p class="api-returns"><code>${r.as}</code>: ${r.list ? html`a list of ${link}` : link}${r.fields?.length ? ", and:" : null}</p>`
      : html`<p class="api-returns">${link}${r.fields?.length ? ", and:" : null}</p>`
    : null;
  return html`<div class="block"><div class="block-head"><span class="block-label">Returns</span></div>${what}${r.fields?.length ? apiFieldsTable(r.fields) : null}</div>`;
}
/**
 * The path as a URL path to type (the curl command's own, without the router's pattern
 * syntax), with its parameters marked so the variable parts read at a glance.
 */
function apiPathHtml(path: string): Html {
  return html`${concretePath(path)
    .split(/(:[A-Za-z_]+)/)
    .map((part, i) => (i % 2 ? html`<span class="api-param">${part}</span>` : part))}`;
}
/** The link that opens the reference at a route, to share in an issue or hand to Claude. */
function routeLink(r: ReferenceEntry): string {
  return `${location.origin}${location.pathname}#/api-reference/${routeAnchor(r)}`;
}
/** What a route's detail looks up in the rest of the reference. */
interface Lookups {
  meanings: Meanings;
  objects: ReadonlyMap<string, string>;
  /** The objects each resource section opens with, by its `<tier>-<resource>` key. */
  heads: ReadonlyMap<string, ReferenceObject[]>;
}

/** Each object under the first tier that lists its resource, keyed as that resource's section. */
function objectHeads(ref: ReferenceResponse): Map<string, ReferenceObject[]> {
  const heads = new Map<string, ReferenceObject[]>();
  for (const o of ref.objects) {
    const g = ref.groups.find((t) => t.resources.some((res) => res.key === o.resource));
    if (g) {
      const sec = `${g.access}-${o.resource}`;
      heads.set(sec, [...(heads.get(sec) ?? []), o]);
    }
  }
  return heads;
}
/**
 * What the filter finds a route by: its name, method, path, and summary, the refusal codes it
 * gives of its own (a code pasted from a response), and the object it returns, by key and title.
 */
function routeHay(r: ReferenceEntry, look: Lookups): string {
  const obj = r.returns?.object;
  return [
    r.title,
    r.method,
    concretePath(r.path),
    r.summary,
    ...(r.errors ?? []).map((e) => e.code),
    ...(obj ? [obj, look.objects.get(obj) ?? "", r.returns?.as ?? ""] : []),
  ]
    .join(" ")
    .toLowerCase();
}
function apiRouteHtml(r: ReferenceEntry, look: Lookups): Html {
  return html`<li data-hay="${routeHay(r, look)}" data-path="${concretePath(r.path).toLowerCase()}" id="route-${routeAnchor(r)}"><details class="api-route">
      <summary class="api-route-sum">
        <span class="api-method m-${r.method}">${r.method}</span>
        <span class="api-route-name"><span class="api-route-title">${r.title}</span><code class="api-path">${apiPathHtml(r.path)}</code></span>
        <span class="api-chev" aria-hidden="true"></span>
      </summary>
      <div class="api-route-detail">
        <div class="api-route-lead">
          <p class="api-summary">${inline(r.summary)}</p>
          <span class="api-route-tools">
            <button type="button" class="copy-btn" data-copy="${`${r.method} ${concretePath(r.path)}`}" data-copy-word="Copy path" aria-label="Copy method and path">${copyFace(false, "Copy path")}</button>
            <button type="button" class="copy-btn" data-copy="${routeLink(r)}" data-copy-word="Copy link" aria-label="Copy a link to this route">${copyFace(false, "Copy link")}</button>
          </span>
        </div>
        ${r.description ? prose(r.description, "api-desc") : null}
        ${apiQueryHtml(r.query)}
        ${apiBodyHtml(r.body, r.accepts)}
        ${apiReturnsHtml(r.returns, look.objects)}
        ${apiErrorsHtml(r.errors, look.meanings)}
        ${apiExample("Request", r.example?.request)}
        ${apiExample("Response", r.example?.response)}
        ${apiCurl(r)}
      </div>
    </details></li>`;
}
/** A resource's routes within a tier, in the order the tier lists them. */
const routesIn = (g: ReferenceGroup, res: ReferenceResource) =>
  g.routes.filter((r) => r.resource === res.key);
// A grid cell: a lone code (a kind, a cause) breaks where its words join, like a name;
// anything else is inline Markdown.
function gridCell(text: string): Html {
  const code = /^`([^`]+)`$/.exec(text)?.[1];
  return html`<td>${code === undefined ? inline(text) : html`<code>${breakable(code)}</code>`}</td>`;
}
// A table of a field's values, under its object's fields: a head row, then a row per value.
function apiTableHtml(t: ReferenceTable): Html {
  return html`<div class="block"><div class="block-head"><span class="block-label">${t.title}</span></div>
      ${prose(t.description, "api-prose")}
      <div class="api-table-wrap"><table class="api-table api-grid"><thead><tr>${t.columns.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${t.rows.map(
        (r) => html`<tr>${r.map(gridCell)}</tr>`,
      )}</tbody></table></div>
    </div>`;
}
// An object its resource's routes return, first under the resource as Stripe puts it: one
// collapsed line that opens to its fields and example.
function apiObjectHtml(o: ReferenceObject): Html {
  return html`<details class="api-object" id="api-objects-${o.key}">
      <summary class="api-route-sum">
        <span class="api-method m-OBJECT">Object</span>
        <span class="api-route-name"><span class="api-route-title">${o.title}</span><span class="api-path">${o.fields.length} ${o.fields.length === 1 ? "field" : "fields"}</span></span>
        <span class="api-chev" aria-hidden="true"></span>
      </summary>
      <div class="api-route-detail">
        ${prose(o.description, "api-prose")}
        ${apiFieldsTable(o.fields)}
        ${(o.tables ?? []).map(apiTableHtml)}
        ${apiExample("Example", o.example)}
      </div>
    </details>`;
}
function apiResourceHtml(g: ReferenceGroup, res: ReferenceResource, look: Lookups): Html {
  const sec = `${g.access}-${res.key}`;
  const routes = routesIn(g, res);
  const objects = look.heads.get(sec) ?? [];
  return html`<div class="api-res" id="api-${sec}" data-sec="${sec}">
      <div class="api-res-head"><h3 tabindex="-1">${res.title}</h3></div>
      ${objects.map(apiObjectHtml)}
      <ul class="api-rows">${routes.map((r) => apiRouteHtml(r, look))}</ul>
    </div>`;
}
function apiSectionHtml(g: ReferenceGroup, look: Lookups): Html {
  return html`<section class="api-section" id="api-${g.access}" data-tier="${g.access}">
      <h2 tabindex="-1">${g.title}</h2>
      <p class="api-blurb muted">${inline(g.blurb)}</p>
      ${g.resources.map((res) => apiResourceHtml(g, res, look))}
    </section>`;
}
// The refusal codes, grouped by the client's next move: each move a heading row across the
// table, so a code and its meaning keep the width.
function apiRefusalsHtml(groups: readonly ReferenceRefusalGroup[]): Html {
  const rows = groups.flatMap((g) => [
    html`<tr class="api-move"><th colspan="2">${g.move}</th></tr>`,
    ...g.codes.map(
      (c) =>
        html`<tr>${nameCell(html`<span class="api-status">${c.status}</span> ${breakable(c.code)}`)}<td>${inline(c.meaning)}</td></tr>`,
    ),
  ]);
  const count = groups.reduce((n, g) => n + g.codes.length, 0);
  // Folded, so the topics read as a page; the filter opens it on a code it holds.
  return html`<details class="api-fold"><summary>Every refusal code <span class="muted">${count} ${count === 1 ? "code" : "codes"}, by what to do next</span></summary><table class="api-table api-refusals"><tbody>${rows}</tbody></table></details>`;
}
// The topics every route shares, before the routes. The filter matches a topic as a whole, by
// its title, and Errors by every refusal code too, so a pasted code no route gives of its own
// still finds what it means.
function apiOverviewHtml(ref: ReferenceResponse): Html {
  const codes = ref.refusals.flatMap((g) => g.codes.map((c) => c.code));
  const concept = (c: ReferenceConcept) =>
    html`<div class="api-res" id="api-overview-${c.key}" data-sec="overview-${c.key}" data-hay="${[c.title, ...(c.key === "errors" ? codes : [])].join(" ").toLowerCase()}">
      <div class="api-res-head"><h3 tabindex="-1">${c.title}</h3></div>
      ${prose(c.text, "api-prose")}
      ${c.key === "errors" ? apiRefusalsHtml(ref.refusals) : null}
    </div>`;
  return html`<section class="api-section" id="api-overview" data-tier="overview">
      <h2 tabindex="-1">Getting started</h2>
      ${ref.concepts.map(concept)}
    </section>`;
}
// The rail: the topics, then each tier, each with its parts beneath it. A tier with one
// resource lists only the tier, since the resource would repeat it. No counts: the rail is
// for moving.
function apiNavHtml(ref: ReferenceResponse): Html {
  const part = (sec: string, title: string) =>
    html`<a href="#/api-reference/${sec}" class="api-nav-res" data-sec="${sec}">${title}</a>`;
  return html`<a href="#/api-reference/overview" class="api-nav-tier" data-sec="overview" data-tier="overview">Getting started</a>${ref.concepts.map(
    (c) => part(`overview-${c.key}`, c.title),
  )}${ref.groups.map(
    (g) =>
      html`<a href="#/api-reference/${g.access}" class="api-nav-tier" data-sec="${g.access}" data-tier="${g.access}">${g.title}</a>${
        g.resources.length > 1
          ? g.resources.map((res) => part(`${g.access}-${res.key}`, res.title))
          : null
      }`,
  )}`;
}

/**
 * Whether a typed or pasted address is a call to a route's path: a full URL or a path, any
 * query or fragment dropped, matching segment for segment, a `:param` segment matching any one.
 */
function callsPath(term: string, path: string): boolean {
  const at = term.replace(/^[a-z]+:\/\/[^/]*/, "").replace(/[?#].*$/, "");
  if (!at.startsWith("/")) {
    return false;
  }
  const want = at.replace(/(.)\/+$/, "$1").split("/");
  const have = path.split("/");
  return (
    want.length === have.length &&
    have.every((seg, i) => (seg.startsWith(":") ? want[i] !== "" : seg === want[i]))
  );
}
/** Whether a route row or a topic holds a word of the query: in its hay, or as a call to its path. */
function holds(el: HTMLElement, word: string): boolean {
  const path = el.dataset.path;
  return (el.dataset.hay ?? "").includes(word) || (path !== undefined && callsPath(word, path));
}

/**
 * Show only the routes and topics that hold every word of the query (routeHay, callsPath), with
 * the resources, tiers, and rail links that still hold one. An empty query shows everything.
 * The last tier still shown is marked, so it keeps the room to scroll up under the bar that the
 * last tier has.
 */
function applyFilter(query: string, navEl: HTMLElement, contentEl: HTMLElement): void {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const sec of $$<HTMLElement>(".api-section", contentEl)) {
    let inTier = 0;
    for (const res of $$<HTMLElement>(".api-res", sec)) {
      // A topic matches as a whole; a resource by its routes.
      const topic = res.dataset.hay !== undefined;
      let inRes = 0;
      for (const item of topic ? [res] : $$<HTMLElement>("li[data-hay]", res)) {
        const hit = terms.every((w) => holds(item, w));
        item.hidden = !hit;
        // A topic with a folded table (Errors' codes) opens it while a filter matches it.
        const fold = topic ? item.querySelector<HTMLDetailsElement>(".api-fold") : null;
        if (fold) {
          fold.open = terms.length > 0 && hit;
        }
        inRes += hit ? 1 : 0;
      }
      res.hidden = inRes === 0;
      const link = navEl.querySelector<HTMLElement>(`a[data-sec="${res.dataset.sec}"]`);
      if (link) {
        link.hidden = inRes === 0;
      }
      inTier += inRes;
    }
    sec.hidden = inTier === 0;
    const tierLink = navEl.querySelector<HTMLElement>(`a[data-tier="${sec.dataset.tier}"]`);
    if (tierLink) {
      tierLink.hidden = inTier === 0;
    }
    shown += inTier;
  }
  const sections = $$<HTMLElement>(".api-section", contentEl);
  const lastShown = sections.filter((sec) => !sec.hidden).at(-1);
  for (const sec of sections) {
    sec.classList.toggle("api-last", sec === lastShown);
  }
  $<HTMLElement>("#apiEmpty", contentEl).hidden = shown > 0;
}

/**
 * Highlight the rail link for what the reader is in: the last tier or resource heading
 * scrolled above a line just under the sticky room bar (so an instant jump lands right,
 * not only a scroll that passes each heading), or the last one once the page is at its
 * bottom. A resource the rail doesn't list lights its tier; a filtered-out one is skipped.
 */
function spyRail(navEl: HTMLElement, contentEl: HTMLElement): void {
  // Measured, not assumed, as the docs' spy does: large-text zoom can push the bar taller.
  const line = ($(".room-bar").getBoundingClientRect().height || 54) + 26;
  const marks = $$(".api-section, .api-res", contentEl).filter((el) => !el.closest("[hidden]"));
  // At the bottom, the last heading wins; a page that hasn't scrolled is at its top.
  const atBottom =
    window.scrollY > 0 &&
    Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight;
  let current = marks[0];
  for (const el of marks) {
    if (atBottom || el.getBoundingClientRect().top <= line) {
      current = el;
    } else {
      break;
    }
  }
  const sec = current?.dataset.sec ?? current?.dataset.tier;
  const tier = current?.closest<HTMLElement>(".api-section")?.dataset.tier;
  // A resource link the rail isn't showing (a phone's rail is the tier chips alone) hands
  // the highlight to its tier.
  const links = $$("a[data-sec]", navEl).filter((a) => getComputedStyle(a).display !== "none");
  const target =
    links.find((a) => a.dataset.sec === sec) ??
    (tier === undefined ? undefined : links.find((a) => a.dataset.tier === tier));
  for (const a of $$("a[data-sec]", navEl)) {
    a.classList.toggle("active", a === target);
  }
}

/**
 * Bring what an address names into view, and the reader's focus with it, so the keyboard and a
 * screen reader carry on from there rather than from the link: a route or an object opened with
 * focus on its line, a tier or a resource with focus on its heading.
 */
function reveal(target: HTMLElement): void {
  const into =
    target instanceof HTMLDetailsElement
      ? target
      : target.matches("li")
        ? target.querySelector("details")
        : null;
  if (into) {
    into.open = true;
  }
  target.scrollIntoView({ block: "start" });
  const focus = into
    ? into.querySelector<HTMLElement>(":scope > summary")
    : target.querySelector<HTMLElement>(":scope > h2, :scope > .api-res-head h3");
  focus?.focus({ preventScroll: true });
}

/**
 * The API reference room. `anchor` (from `#/api-reference/<anchor>`) names what to bring into view
 * once the reference is in: a route (`cancel-send`), opened, or a part of the page
 * the rail and Returns links name (`admin-sends`, `objects-send`, `overview-errors`). One that
 * names nothing opens the reference at its top.
 */
export async function renderReference(
  root: HTMLElement,
  signal: AbortSignal,
  anchor?: string,
): Promise<void> {
  setHtml(
    root,
    roomShell(
      "api-reference",
      html`<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
      html`<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
    ),
  );
  const navEl = $("#apiNav");
  const contentEl = $("#apiContent");
  // Delegate clicks synchronously with one listener each on the stable nav and page, so they
  // survive the async fill below: a rail click, or a route's link to an object, jumps there
  // in place. Each is a real link to its address, so a modified click (a new tab) is the
  // browser's, and the address bar follows the jump without a hashchange that would render
  // the room again.
  const jump = (ev: MouseEvent) => {
    const a = ev.target instanceof Element ? ev.target.closest<HTMLElement>("a[data-sec]") : null;
    const target = a?.dataset.sec ? document.getElementById(`api-${a.dataset.sec}`) : null;
    if (!target || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
      return;
    }
    ev.preventDefault();
    // A filter may have hidden what the link points at (a route's object, under another
    // resource): clear it, rather than leave the click to do nothing.
    if (target.closest("[hidden]")) {
      filterTo("");
    }
    history.replaceState(history.state, "", a?.getAttribute("href") ?? location.hash);
    reveal(target);
  };
  navEl.addEventListener("click", jump);
  contentEl.addEventListener("click", jump);
  let ref: ReferenceResponse;
  try {
    ref = await api<ReferenceResponse>("/api/reference", { signal });
  } catch (e) {
    renderError(contentEl, describeError(e), () =>
      mount((r, sig) => renderReference(r, sig, anchor)),
    );
    return;
  }
  const look: Lookups = {
    meanings: new Map(ref.refusals.flatMap((g) => g.codes.map((c) => [c.code, c.meaning]))),
    objects: new Map(ref.objects.map((o) => [o.key, o.title])),
    heads: objectHeads(ref),
  };

  setHtml(navEl, apiNavHtml(ref));
  setHtml(
    contentEl,
    html`<header class="api-head"><h1>API reference</h1><p class="muted">Every endpoint this instance serves, the one API the web editor and Claude both call. It's read from the running code, so it always matches this version. Base URL <code>${location.origin}</code>.</p><div class="api-filter">${icon("search")}<input type="search" id="apiFilter" placeholder="Filter by name, path, URL, or error code" autocomplete="off" aria-label="Filter routes" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd><button type="button" class="icon api-filter-clear" id="apiFilterClear" aria-label="Clear filter" hidden>${icon("x")}</button></div></header>${apiOverviewHtml(ref)}${ref.groups.map((g) => apiSectionHtml(g, look))}<p class="api-empty muted" id="apiEmpty" hidden>Nothing matches. Try a path segment like <code>sends</code>, a method like <code>DELETE</code>, or a code like <code>stale_revision</code>, or start from <a href="#/api-reference/overview" data-sec="overview">Getting started</a>.</p>`,
  );
  const filterEl = $<HTMLInputElement>("#apiFilter");
  const clearEl = $("#apiFilterClear");
  const spy = () => spyRail(navEl, contentEl);
  const filterTo = (query: string) => {
    filterEl.value = query;
    clearEl.hidden = query === "";
    applyFilter(query, navEl, contentEl);
    spy();
  };
  filterEl.addEventListener("input", () => filterTo(filterEl.value));
  clearEl.addEventListener("click", () => {
    filterTo("");
    filterEl.focus();
  });
  // A code block's Copy puts its plain text (the example, or the curl command) on the
  // clipboard and says so where it sits (ui/copy.ts).
  wireCopy(contentEl);
  // "/" jumps to the filter from anywhere in the room (unless typing elsewhere); Escape
  // in the filter clears it. Bound to the view, so it ends when the room does.
  document.addEventListener(
    "keydown",
    (ev) => {
      const typing =
        ev.target instanceof HTMLElement &&
        (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName));
      if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        filterEl.focus();
      } else if (ev.key === "Escape" && ev.target === filterEl && filterEl.value) {
        filterTo("");
      }
    },
    { signal },
  );

  // Mark the last tier (the filter keeps it current from here).
  applyFilter("", navEl, contentEl);
  // The rail follows the reading position, and the filter, which moves every heading.
  window.addEventListener("scroll", spy, { passive: true, signal });
  // Its own page: start at the top, not wherever the last doc was scrolled to, or at the
  // route the address names, opened.
  window.scrollTo(0, 0);
  const target = anchor
    ? (document.getElementById(`route-${anchor}`) ?? document.getElementById(`api-${anchor}`))
    : null;
  if (target) {
    reveal(target);
  }
  spy();
}
