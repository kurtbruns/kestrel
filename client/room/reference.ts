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
  RouteError,
  RouteReturns,
} from "../../shared/reference";
import { api, describeError } from "../api";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { codeBlock, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { highlightCurl, highlightJson } from "../ui/highlight";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { renderError } from "../ui/widgets";
import { concretePath, curlCommand } from "./curl";
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
// Query params for a list route, rendered as a name→description table so the
// generated reference documents filter/sort/pagination from the registration.
function apiQueryHtml(query: QueryParam[] | undefined): Html | null {
  if (!query?.length) {
    return null;
  }
  const rows = query.map(
    (q) =>
      html`<tr><td><code>${q.name}</code>${q.required ? html` <span class="api-req">required</span>` : null}</td><td class="muted">${q.description}</td></tr>`,
  );
  return html`<div class="block"><div class="block-head"><span class="block-label">Query</span></div><table class="api-query"><tbody>${rows}</tbody></table></div>`;
}
// A route's body fields, with each one's type and whether the request is refused without it.
function apiBodyHtml(body: BodyField[] | undefined): Html | null {
  if (!body?.length) {
    return null;
  }
  const rows = body.map(
    (f) =>
      html`<tr><td><code>${f.name}</code>${f.required ? html` <span class="api-req">required</span>` : null}</td><td><code class="api-type">${f.type}</code></td><td class="muted">${f.description}</td></tr>`,
  );
  return html`<div class="block"><div class="block-head"><span class="block-label">Body</span></div><table class="api-query api-body"><tbody>${rows}</tbody></table></div>`;
}
// The refusals the route gives of its own, each with its status and the fields it carries,
// and when: the route's own words, or the code's meaning from the refusal table.
function apiErrorsHtml(errors: RouteError[] | undefined, meanings: Meanings): Html | null {
  if (!errors?.length) {
    return null;
  }
  const rows = errors.map(
    (e) =>
      html`<tr><td><span class="api-status">${e.status}</span> <code>${e.code}</code></td><td class="muted">${e.when ?? meanings.get(e.code) ?? ""}${e.details?.length ? html` With ${e.details.map((d, i) => html`${i ? ", " : ""}<code>${d}</code>`)}.` : null}</td></tr>`,
  );
  return html`<div class="block"><div class="block-head"><span class="block-label">Refusals</span></div><table class="api-query api-errors"><tbody>${rows}</tbody></table></div>`;
}
// Fields with their types and one line each, an enum's values listed under its line.
function apiFieldsTable(fields: readonly ReferenceField[]): Html {
  const rows = fields.map(
    (f) =>
      html`<tr><td><code>${f.name}</code></td><td><code class="api-type">${f.type}</code></td><td class="muted">${f.description}${
        f.values?.length
          ? html`<ul class="api-values">${f.values.map((v) => html`<li><code>${v.value}</code> ${v.description}</li>`)}</ul>`
          : null
      }</td></tr>`,
  );
  return html`<table class="api-query api-fields"><tbody>${rows}</tbody></table>`;
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
    ? html`<a href="#/reference" class="api-obj-link" data-sec="objects-${r.object}">${objects.get(r.object) ?? r.object}</a>`
    : null;
  const what = link
    ? r.as
      ? html`<p class="api-returns"><code>${r.as}</code>: ${r.list ? html`a list of ${link}` : link}${r.fields?.length ? ", and:" : null}</p>`
      : html`<p class="api-returns">${link}${r.fields?.length ? ", and:" : null}</p>`
    : null;
  return html`<div class="block"><div class="block-head"><span class="block-label">Returns</span></div>${what}${r.fields?.length ? apiFieldsTable(r.fields) : null}</div>`;
}
// The body types a write accepts, from the registration the router enforces them by. A
// route that takes no body lists none.
function apiAcceptsHtml(accepts: readonly string[] | undefined): Html | null {
  if (!accepts?.length) {
    return null;
  }
  const rows = accepts.map((t) => html`<tr><td><code>${t}</code></td></tr>`);
  return html`<div class="block"><div class="block-head"><span class="block-label">Content-Type</span></div><table class="api-query api-accepts"><tbody>${rows}</tbody></table></div>`;
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
function apiRouteHtml(r: ReferenceEntry, look: Lookups): Html {
  // What the filter matches: the route's name, the method, the path, and the summary.
  const hay = `${r.title} ${r.method} ${concretePath(r.path)} ${r.summary}`.toLowerCase();
  return html`<li data-hay="${hay}"><details class="api-route">
      <summary class="api-route-sum">
        <span class="api-method m-${r.method}">${r.method}</span>
        <span class="api-route-name"><span class="api-route-title">${r.title}</span><code class="api-path">${apiPathHtml(r.path)}</code></span>
        <span class="api-chev" aria-hidden="true"></span>
      </summary>
      <div class="api-route-detail">
        <p class="api-summary">${r.summary}</p>
        ${r.description ? html`<p class="api-desc muted">${r.description}</p>` : null}
        ${apiQueryHtml(r.query)}
        ${apiAcceptsHtml(r.accepts)}
        ${apiBodyHtml(r.body)}
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
// An object its resource's routes return, first under the resource as Stripe puts it: one
// collapsed line that opens to its fields and example.
function apiObjectHtml(o: ReferenceObject): Html {
  return html`<details class="api-object" id="api-objects-${o.key}">
      <summary class="api-object-sum">
        <span class="api-object-name"><span class="api-route-title">${o.title}</span><span class="muted">${o.fields.length} ${o.fields.length === 1 ? "field" : "fields"}</span></span>
        <span class="api-chev" aria-hidden="true"></span>
      </summary>
      <div class="api-object-detail">
        ${apiProseHtml(o.description)}
        ${apiFieldsTable(o.fields)}
        ${apiExample("Example", o.example)}
      </div>
    </details>`;
}
function apiResourceHtml(g: ReferenceGroup, res: ReferenceResource, look: Lookups): Html {
  const sec = `${g.access}-${res.key}`;
  const routes = routesIn(g, res);
  const objects = look.heads.get(sec) ?? [];
  return html`<div class="api-res" id="api-${sec}" data-sec="${sec}">
      <div class="api-res-head"><h3>${res.title}</h3></div>
      ${objects.map(apiObjectHtml)}
      <ul class="api-rows">${routes.map((r) => apiRouteHtml(r, look))}</ul>
    </div>`;
}
function apiSectionHtml(g: ReferenceGroup, look: Lookups): Html {
  return html`<section class="api-section" id="api-${g.access}" data-tier="${g.access}">
      <h2>${g.title}</h2>
      <p class="api-blurb muted">${g.blurb}</p>
      ${g.resources.map((res) => apiResourceHtml(g, res, look))}
    </section>`;
}
/** Markdown paragraphs as paragraphs. */
function apiProseHtml(text: string): Html {
  return html`${text.split(/\n\n+/).map((p) => html`<p class="api-prose">${p}</p>`)}`;
}
// The refusal codes, grouped by the client's next move: each move a heading row across the
// table, so a code and its meaning keep the width.
function apiRefusalsHtml(groups: readonly ReferenceRefusalGroup[]): Html {
  const rows = groups.flatMap((g) => [
    html`<tr class="api-move"><th colspan="2">${g.move}</th></tr>`,
    ...g.codes.map(
      (c) =>
        html`<tr><td><span class="api-status">${c.status}</span> <code>${c.code}</code></td><td class="muted">${c.meaning}</td></tr>`,
    ),
  ]);
  return html`<table class="api-query api-refusals"><tbody>${rows}</tbody></table>`;
}
// The topics every route shares, before the routes: a static section the route filter hides.
function apiOverviewHtml(ref: ReferenceResponse): Html {
  const concept = (c: ReferenceConcept) =>
    html`<div class="api-res" id="api-overview-${c.key}" data-sec="overview-${c.key}">
      <div class="api-res-head"><h3>${c.title}</h3></div>
      ${apiProseHtml(c.text)}
      ${c.key === "errors" ? apiRefusalsHtml(ref.refusals) : null}
    </div>`;
  return html`<section class="api-section" id="api-overview" data-tier="overview" data-static>
      <h2>Getting started</h2>
      ${ref.concepts.map(concept)}
    </section>`;
}
// The rail: the topics, then each tier, each with its parts beneath it. A tier with one
// resource lists only the tier, since the resource would repeat it. No counts: the rail is
// for moving.
function apiNavHtml(ref: ReferenceResponse): Html {
  const part = (sec: string, title: string) =>
    html`<a href="#/reference" class="api-nav-res" data-sec="${sec}">${title}</a>`;
  return html`<a href="#/reference" class="api-nav-tier" data-sec="overview" data-tier="overview">Getting started</a>${ref.concepts.map(
    (c) => part(`overview-${c.key}`, c.title),
  )}${ref.groups.map(
    (g) =>
      html`<a href="#/reference" class="api-nav-tier" data-sec="${g.access}" data-tier="${g.access}">${g.title}</a>${
        g.resources.length > 1
          ? g.resources.map(
              (res) =>
                html`<a href="#/reference" class="api-nav-res" data-sec="${g.access}-${res.key}">${res.title}</a>`,
            )
          : null
      }`,
  )}`;
}

/**
 * Show only the routes whose name, method, path, or summary contains every word of the query,
 * with the resources, tiers, and rail links that still hold one. An empty query shows
 * everything. The last tier still shown is marked, so it keeps the room to scroll
 * up under the bar that the last tier has.
 */
function applyFilter(query: string, navEl: HTMLElement, contentEl: HTMLElement): void {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const sec of $$<HTMLElement>(".api-section", contentEl)) {
    // What every route shares has no rows to match: shown whole, and out of the way while filtering.
    if (sec.dataset.static !== undefined) {
      sec.hidden = terms.length > 0;
      for (const a of $$<HTMLElement>(`a[data-sec^="${sec.dataset.tier}"]`, navEl)) {
        a.hidden = sec.hidden;
      }
      continue;
    }
    let inTier = 0;
    for (const res of $$<HTMLElement>(".api-res", sec)) {
      let inRes = 0;
      for (const li of $$<HTMLElement>("li[data-hay]", res)) {
        const hit = terms.every((w) => (li.dataset.hay ?? "").includes(w));
        li.hidden = !hit;
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

export async function renderReference(root: HTMLElement, signal: AbortSignal): Promise<void> {
  setHtml(
    root,
    roomShell(
      "reference",
      html`<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
      html`<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
    ),
  );
  const navEl = $("#apiNav");
  const contentEl = $("#apiContent");
  // Delegate clicks synchronously with one listener each on the stable nav and page, so they
  // survive the async fill below: a rail click, or a route's link to an object, jumps there.
  const jump = (ev: MouseEvent) => {
    const a = ev.target instanceof Element ? ev.target.closest<HTMLElement>("a[data-sec]") : null;
    const sec = a?.dataset.sec;
    if (!sec) {
      return;
    }
    ev.preventDefault();
    const target = document.getElementById(`api-${sec}`);
    // An object is a collapsed line under its resource: a link to it opens it too.
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
    }
    target?.scrollIntoView({ block: "start" });
  };
  navEl.addEventListener("click", jump);
  contentEl.addEventListener("click", jump);
  let ref: ReferenceResponse;
  try {
    ref = await api<ReferenceResponse>("/api/reference", { signal });
  } catch (e) {
    renderError(contentEl, describeError(e), () => mount(renderReference));
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
    html`<header class="api-head"><h1>API reference</h1><p class="muted">Generated from the route registration, so every endpoint the app and Claude can call is listed here. Base URL <code>${location.origin}</code>.</p><div class="api-filter">${icon("search")}<input type="search" id="apiFilter" placeholder="Filter routes by name, method, or path" autocomplete="off" aria-label="Filter routes" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd><button type="button" class="icon api-filter-clear" id="apiFilterClear" aria-label="Clear filter" hidden>${icon("x")}</button></div></header>${apiOverviewHtml(ref)}${ref.groups.map((g) => apiSectionHtml(g, look))}<p class="api-empty muted" id="apiEmpty" hidden>No routes match. Try a path segment like <code>sends</code> or a method like <code>DELETE</code>.</p>`,
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
  // Its own page — start at the top, not wherever the last doc was scrolled to.
  window.scrollTo(0, 0);
  spy();
}
