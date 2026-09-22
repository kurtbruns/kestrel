// The API reference room, rendered from /api/reference.

import type {
  QueryParam,
  ReferenceEntry,
  ReferenceGroup,
  ReferenceResponse,
} from "../../shared/reference";
import { api } from "../api";
import { app } from "../shell";
import { $, $$ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";
import { roomShell } from "./shell";

// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA
// renders it natively as a sticky rail of tiers beside the route list, so it
// matches the app's own chrome (no iframe, unlike the earlier build).
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
function apiRouteHtml(r: ReferenceEntry): Html {
  return html`<div class="api-route">
      <div class="api-route-head">
        <span class="api-method m-${r.method}">${r.method}</span>
        <code class="api-path">${r.path}</code>
        <span class="api-tier">${r.access}</span>
      </div>
      <p class="api-summary">${r.summary}</p>
      ${r.description ? html`<p class="api-desc muted">${r.description}</p>` : null}
      ${apiQueryHtml(r.query)}
      ${apiExample("Request", r.example?.request)}
      ${apiExample("Response", r.example?.response)}
    </div>`;
}
function apiSectionHtml(g: ReferenceGroup): Html {
  return html`<section class="api-section" id="api-${g.access}">
      <h2>${g.title}</h2>
      <p class="api-blurb muted">${g.blurb}</p>
      ${g.routes.map(apiRouteHtml)}
    </section>`;
}

// Highlights whichever section is in view. One observer for the room: it lives as long
// as the view and is disconnected when the next render replaces it.
let sectionObserver: IntersectionObserver | null = null;

export async function renderReference(): Promise<void> {
  setHtml(
    app,
    roomShell(
      "reference",
      html`<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
      html`<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
    ),
  );
  const navEl = $("#apiNav");
  const contentEl = $("#apiContent");
  // Delegate clicks synchronously with one listener on the stable nav, so it survives
  // the async fill below: a sidebar click jumps to that section.
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
    ({ groups } = await api<ReferenceResponse>("/api/reference"));
  } catch (e) {
    renderError(contentEl, e instanceof Error ? e.message : String(e), renderReference);
    return;
  }

  setHtml(
    navEl,
    html`${groups.map((g, i) =>
      i === 0
        ? html`<a href="#/reference" data-sec="${g.access}" class="active">${g.title}<span class="api-nav-count">${g.routes.length}</span></a>`
        : html`<a href="#/reference" data-sec="${g.access}">${g.title}<span class="api-nav-count">${g.routes.length}</span></a>`,
    )}`,
  );
  setHtml(
    contentEl,
    html`<header class="api-head"><h1>API reference</h1><p class="muted">Generated from the route registration, so every endpoint the app and Claude can call is listed here. Base URL <code>${location.origin}</code>.</p></header>${groups.map(apiSectionHtml)}`,
  );

  // Highlight whichever section is in view. Query the live nav each time so it
  // never holds a stale link reference.
  sectionObserver?.disconnect();
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const sec = e.target.id.replace(/^api-/, "");
          for (const a of $$("a[data-sec]", navEl)) {
            a.classList.toggle("active", a.dataset.sec === sec);
          }
        }
      }
    },
    { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
  );
  sectionObserver = obs;
  for (const g of groups) {
    const el = document.getElementById(`api-${g.access}`);
    if (el) {
      obs.observe(el);
    }
  }
  // Its own page — start at the top, not wherever the last doc was scrolled to.
  window.scrollTo(0, 0);
}
