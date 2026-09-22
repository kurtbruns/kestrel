// @ts-nocheck
// The API reference room, rendered from /api/reference.

import { api } from "../api";
import { esc } from "../helpers";
import { roomShell } from "../icons";
import { renderError } from "../notice";
import { app } from "../shell";

// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA
// renders it natively as a sticky rail of tiers beside the route list, so it
// matches the app's own chrome (no iframe, unlike the earlier build).
function apiExample(label, value) {
  return value === undefined
    ? ""
    : `<div class="api-ex"><span class="api-ex-label">${esc(label)}</span><pre><code>${esc(
        JSON.stringify(value, null, 2),
      )}</code></pre></div>`;
}
// Query params for a list route, rendered as a name→description table so the
// generated reference documents filter/sort/pagination from the registration.
function apiQueryHtml(query) {
  if (!query?.length) {
    return "";
  }
  const rows = query
    .map(
      (q) =>
        `<tr><td><code>${esc(q.name)}</code></td><td class="muted">${esc(q.description)}</td></tr>`,
    )
    .join("");
  return `<div class="api-ex"><span class="api-ex-label">Query</span><table class="api-query"><tbody>${rows}</tbody></table></div>`;
}
function apiRouteHtml(r) {
  return `<div class="api-route">
      <div class="api-route-head">
        <span class="api-method m-${esc(r.method)}">${esc(r.method)}</span>
        <code class="api-path">${esc(r.path)}</code>
        <span class="api-tier">${esc(r.access)}</span>
      </div>
      <p class="api-summary">${esc(r.summary)}</p>
      ${r.description ? `<p class="api-desc muted">${esc(r.description)}</p>` : ""}
      ${apiQueryHtml(r.query)}
      ${apiExample("Request", r.example?.request)}
      ${apiExample("Response", r.example?.response)}
    </div>`;
}
function apiSectionHtml(g) {
  return `<section class="api-section" id="api-${esc(g.access)}">
      <h2>${esc(g.title)}</h2>
      <p class="api-blurb muted">${esc(g.blurb)}</p>
      ${g.routes.map(apiRouteHtml).join("")}
    </section>`;
}
export async function renderReference() {
  app.innerHTML = roomShell(
    "reference",
    `<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
    `<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
  );
  const navEl = document.getElementById("apiNav");
  const contentEl = document.getElementById("apiContent");
  // Delegate clicks synchronously with one listener on the stable nav, so it survives
  // the async fill below: a sidebar click jumps to that section.
  navEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-sec]");
    if (!a) {
      return;
    }
    ev.preventDefault();
    document.getElementById(`api-${a.dataset.sec}`)?.scrollIntoView({ block: "start" });
  });
  let groups;
  try {
    ({ groups } = await api("/api/reference"));
  } catch (e) {
    renderError(contentEl, e.message, renderReference);
    return;
  }

  navEl.innerHTML = groups
    .map(
      (g, i) =>
        `<a href="#/reference" data-sec="${esc(g.access)}"${i === 0 ? ' class="active"' : ""}>` +
        `${esc(g.title)}<span class="api-nav-count">${g.routes.length}</span></a>`,
    )
    .join("");
  contentEl.innerHTML =
    `<header class="api-head"><h1>API reference</h1>` +
    `<p class="muted">Generated from the route registration, so every endpoint the app and Claude can call is listed here. ` +
    `Base URL <code>${esc(location.origin)}</code>.</p></header>` +
    groups.map(apiSectionHtml).join("");

  // Highlight whichever section is in view. Query the live nav each time so it
  // never holds a stale link reference; park the observer on the nav so it lives
  // as long as the view (GC'd on unmount).
  navEl._obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const sec = e.target.id.replace(/^api-/, "");
          for (const a of navEl.querySelectorAll("a[data-sec]")) {
            a.classList.toggle("active", a.dataset.sec === sec);
          }
        }
      }
    },
    { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
  );
  for (const g of groups) {
    const el = document.getElementById(`api-${g.access}`);
    if (el) {
      navEl._obs.observe(el);
    }
  }
  // Its own page — start at the top, not wherever the last doc was scrolled to.
  window.scrollTo(0, 0);
}
