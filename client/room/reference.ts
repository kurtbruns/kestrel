// The API reference room, rendered from /api/reference.

import type {
  QueryParam,
  ReferenceEntry,
  ReferenceGroup,
  ReferenceResource,
  ReferenceResponse,
} from "../../shared/reference";
import { api } from "../api";
import { mount } from "../lifecycle";
import { $, $$ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";
import { roomShell } from "./shell";

// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA renders
// it natively: a rail of tiers and their resources beside the route list, where each
// route is one scannable row, a native <details>, that opens in place to its full
// documentation.
function apiExample(label: string, value: unknown): Html | null {
  return value === undefined
    ? null
    : html`<div class="api-ex"><span class="api-ex-label">${label}</span><pre><code>${JSON.stringify(value, null, 2)}</code></pre></div>`;
}
// Query params for a list route, rendered as a name→description table so the
// generated reference documents filter/sort/pagination from the registration.
function apiQueryHtml(query: QueryParam[] | undefined): Html | null {
  if (!query?.length) {
    return null;
  }
  const rows = query.map(
    (q) => html`<tr><td><code>${q.name}</code></td><td class="muted">${q.description}</td></tr>`,
  );
  return html`<div class="api-ex"><span class="api-ex-label">Query</span><table class="api-query"><tbody>${rows}</tbody></table></div>`;
}
/** The path with its parameters (`:id`, `:key(.*)`) marked, so the variable parts read at a glance. */
function apiPathHtml(path: string): Html {
  return html`${path
    .split(/(:[A-Za-z_]+(?:\([^)]*\))?)/)
    .map((part, i) => (i % 2 ? html`<span class="api-param">${part}</span>` : part))}`;
}
function apiRouteHtml(r: ReferenceEntry): Html {
  // What the filter matches: the method, the path, and the one-line summary.
  const hay = `${r.method} ${r.path} ${r.summary}`.toLowerCase();
  return html`<li data-hay="${hay}"><details class="api-route">
      <summary class="api-route-sum">
        <span class="api-method m-${r.method}">${r.method}</span>
        <code class="api-path">${apiPathHtml(r.path)}</code>
        <span class="api-route-line">${r.summary}</span>
        <span class="api-chev" aria-hidden="true"></span>
      </summary>
      <div class="api-route-detail">
        <p class="api-summary">${r.summary}</p>
        ${r.description ? html`<p class="api-desc muted">${r.description}</p>` : null}
        ${apiQueryHtml(r.query)}
        ${apiExample("Request", r.example?.request)}
        ${apiExample("Response", r.example?.response)}
      </div>
    </details></li>`;
}
/** A resource's routes within a tier, in the order the tier lists them. */
const routesIn = (g: ReferenceGroup, res: ReferenceResource) =>
  g.routes.filter((r) => r.resource === res.key);
function apiResourceHtml(g: ReferenceGroup, res: ReferenceResource): Html {
  const sec = `${g.access}-${res.key}`;
  const routes = routesIn(g, res);
  return html`<div class="api-res" id="api-${sec}" data-sec="${sec}">
      <div class="api-res-head"><h3>${res.title}</h3><span class="api-nav-count" data-count>${routes.length}</span></div>
      <ul class="api-rows">${routes.map(apiRouteHtml)}</ul>
    </div>`;
}
function apiSectionHtml(g: ReferenceGroup): Html {
  return html`<section class="api-section" id="api-${g.access}" data-tier="${g.access}">
      <h2>${g.title}</h2>
      <p class="api-blurb muted">${g.blurb}</p>
      ${g.resources.map((res) => apiResourceHtml(g, res))}
    </section>`;
}
// The rail: each tier, then its resources beneath it. A tier with one resource lists only
// the tier, since the resource would repeat it.
function apiNavHtml(groups: ReferenceGroup[]): Html {
  return html`${groups.map(
    (g) =>
      html`<a href="#/reference" class="api-nav-tier" data-sec="${g.access}" data-tier="${g.access}">${g.title}<span class="api-nav-count" data-count>${g.routes.length}</span></a>${
        g.resources.length > 1
          ? g.resources.map(
              (res) =>
                html`<a href="#/reference" class="api-nav-res" data-sec="${g.access}-${res.key}">${res.title}<span class="api-nav-count" data-count>${routesIn(g, res).length}</span></a>`,
            )
          : null
      }`,
  )}`;
}

/**
 * Show only the routes whose method, path, or summary contains every word of the query,
 * and keep each count (resource, tier, rail) to what is still shown. An empty query
 * shows everything.
 */
function applyFilter(query: string, navEl: HTMLElement, contentEl: HTMLElement): void {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const sec of $$<HTMLElement>(".api-section", contentEl)) {
    let inTier = 0;
    for (const res of $$<HTMLElement>(".api-res", sec)) {
      let inRes = 0;
      for (const li of $$<HTMLElement>("li[data-hay]", res)) {
        const hit = terms.every((w) => (li.dataset.hay ?? "").includes(w));
        li.hidden = !hit;
        inRes += hit ? 1 : 0;
      }
      res.hidden = inRes === 0;
      $("[data-count]", res).textContent = String(inRes);
      const link = navEl.querySelector<HTMLElement>(`a[data-sec="${res.dataset.sec}"]`);
      if (link) {
        link.hidden = inRes === 0;
        $("[data-count]", link).textContent = String(inRes);
      }
      inTier += inRes;
    }
    sec.hidden = inTier === 0;
    const tierLink = navEl.querySelector<HTMLElement>(`a[data-tier="${sec.dataset.tier}"]`);
    if (tierLink) {
      tierLink.hidden = inTier === 0;
      $("[data-count]", tierLink).textContent = String(inTier);
    }
    shown += inTier;
  }
  $<HTMLElement>("#apiEmpty", contentEl).hidden = shown > 0;
}

// Highlights whichever resource is in view. One observer for the room: it lives as long
// as the view and is disconnected when the next render replaces it.
let sectionObserver: IntersectionObserver | null = null;

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
  // Delegate clicks synchronously with one listener on the stable nav, so it survives
  // the async fill below: a rail click jumps to that tier or resource.
  navEl.addEventListener("click", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest<HTMLElement>("a[data-sec]") : null;
    const sec = a?.dataset.sec;
    if (!sec) {
      return;
    }
    ev.preventDefault();
    document.getElementById(`api-${sec}`)?.scrollIntoView({ block: "start" });
  });
  let groups: ReferenceGroup[];
  try {
    ({ groups } = await api<ReferenceResponse>("/api/reference", { signal }));
  } catch (e) {
    renderError(contentEl, e instanceof Error ? e.message : String(e), () =>
      mount(renderReference),
    );
    return;
  }

  setHtml(navEl, apiNavHtml(groups));
  navEl.querySelector("a")?.classList.add("active");
  setHtml(
    contentEl,
    html`<header class="api-head"><h1>API reference</h1><p class="muted">Generated from the route registration, so every endpoint the app and Claude can call is listed here. Base URL <code>${location.origin}</code>.</p><label class="api-filter"><input type="search" id="apiFilter" placeholder="Filter routes" autocomplete="off" aria-label="Filter routes" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd></label></header>${groups.map(apiSectionHtml)}<p class="api-empty muted" id="apiEmpty" hidden>No routes match. Try a path segment like <code>sends</code> or a method like <code>DELETE</code>.</p>`,
  );
  const filterEl = $<HTMLInputElement>("#apiFilter");
  filterEl.addEventListener("input", () => applyFilter(filterEl.value, navEl, contentEl));
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
        filterEl.value = "";
        applyFilter("", navEl, contentEl);
      }
    },
    { signal },
  );

  // Highlight the resource in view, or its tier when the rail lists the tier alone.
  // Query the live nav each time so it never holds a stale link reference.
  sectionObserver?.disconnect();
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || !(e.target instanceof HTMLElement)) {
          continue;
        }
        const sec = e.target.dataset.sec;
        const tier = e.target.closest<HTMLElement>(".api-section")?.dataset.tier;
        const links = $$("a[data-sec]", navEl);
        const target =
          links.find((a) => a.dataset.sec === sec) ?? links.find((a) => a.dataset.tier === tier);
        for (const a of links) {
          a.classList.toggle("active", a === target);
        }
      }
    },
    { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
  );
  sectionObserver = obs;
  for (const el of $$(".api-res", contentEl)) {
    obs.observe(el);
  }
  // Its own page — start at the top, not wherever the last doc was scrolled to.
  window.scrollTo(0, 0);
}
