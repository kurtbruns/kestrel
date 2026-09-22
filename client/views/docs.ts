// The in-app docs room: the setup guide fetched from the authed /api/docs routes.

import type { DocFragment, DocsResponse } from "../../shared/docs";
import { api } from "../api";
import { $, $$ } from "../dom";
import { toast } from "../helpers";
import { type Html, html, setHtml, unsafeHtml } from "../html";
import { renderError } from "../notice";
import { roomShell } from "../room";
import { app } from "../shell";
import { appState } from "../state";

// The setup guide, authored in docs/setup/*.md and served read-only by the authed
// GET /api/docs route as sanitized HTML fragments. `#/docs` is the index — an intro over a
// numbered list of every doc; `#/docs/:slug` is one doc, its rail a back-link to the index
// plus that doc's "On this page" (never a tree of all docs). No iframe: the content is
// trusted (repo markdown, hygiene-passed), so injecting the fragments is safe. Fetched once
// and cached (the bundle never changes at runtime), so paging is instant.
let docsCache: DocFragment[] | null = null;

// A doc card's blurb on the index: the doc's own first paragraph, condensed. Derived here
// (docs carry no front-matter description) so it stays in sync with the doc itself.
function docDescription(doc: DocFragment): string {
  const tmp = document.createElement("div");
  // The API's rendered HTML, parsed only to read its first paragraph; never attached.
  setHtml(tmp, unsafeHtml(doc.html || ""));
  const raw = (tmp.querySelector("p")?.textContent || "").trim().replace(/\s+/g, " ");
  // A paragraph that leads into a list ends in ":" — on a card that reads as a cut-off
  // sentence, so it ends in an ellipsis like a truncated blurb does.
  const leadsIn = /[:;,]$/.test(raw);
  const text = raw.replace(/[\s:;,]+$/, "");
  const MAX = 150;
  if (text.length > MAX) {
    return `${text.slice(0, MAX).replace(/[\s.,;:]+\S*$/, "")}…`;
  }
  return leadsIn ? `${text}…` : text;
}

export async function renderDocs(slug?: string): Promise<void> {
  setHtml(
    app,
    roomShell("docs", null, html`<div class="docs-index"><p class="muted">Loading…</p></div>`),
  );
  if (!docsCache) {
    // The first visit fetches; everything below rewrites the whole view, so if the route
    // moved on while the request was in flight (a tap on API, or a different doc), this
    // render is stale and must not paint over the one that replaced it.
    const wanted = location.hash;
    try {
      docsCache = (await api<DocsResponse>("/api/docs")).docs;
    } catch (e) {
      if (location.hash === wanted) {
        renderError($(".room-main"), e instanceof Error ? e.message : String(e), () =>
          renderDocs(slug),
        );
      }
      return;
    }
    if (location.hash !== wanted) {
      return;
    }
  }
  const docs = docsCache;
  if (!docs.length) {
    setHtml($(".room-main"), html`<p class="muted">No documentation.</p>`);
    return;
  }
  if (slug) {
    renderDocPage(docs, slug);
  } else {
    renderDocsIndex(docs);
  }
}

// The index: an intro over a numbered list of every doc, in reading order. It keeps the
// room's two-column shape (a doc page's rail is that doc's "On this page"); here the rail
// holds the project's external links — the reference room is about Kestrel itself, so this
// is where getkestrel.dev and the source live.
function renderDocsIndex(docs: DocFragment[]): void {
  const cards = docs.map((d, i) => {
    const desc = docDescription(d);
    return html`<li><a class="doc-card" href="#/docs/${d.slug}"><span class="doc-card-n">${String(i + 1).padStart(2, "0")}</span><span class="doc-card-main"><span class="doc-card-t">${d.title} <span class="doc-card-go" aria-hidden="true">→</span></span>${desc ? html`<span class="doc-card-d">${desc}</span>` : null}</span></a></li>`;
  });
  const main = html`<div class="docs-index"><p class="eyebrow">Documentation</p><h1>Set up &amp; operate Kestrel</h1><p class="docs-index-intro">How to take a fresh instance to a live newsletter — the run-once, out-of-band steps against your own Cloudflare account, DNS, and email provider.</p><ol class="doc-cards">${cards}</ol></div>`;
  // Three uniform out-links under a "Kestrel" label — the same shape as the API rail's
  // label + tiers, so mobile can give both the same chip row. getkestrel.dev is the
  // project's home, the same for every instance, so it's a constant; the source and
  // license links are the deploy's own repo (package.json → build stamp), so they're
  // absent when no repo is known.
  // Each link carries a short form for the mobile chip row (styles.css swaps which span
  // shows); the full label stays the accessible name at every width.
  const repoUrl = appState.appConfig?.deployment.build.repoUrl || "";
  const out = (href: string, label: string, short = label): Html =>
    html`<a class="rail-link" href="${href}" target="_blank" rel="noopener" aria-label="${label}"><span class="rail-link-full">${label}</span><span class="rail-link-short" aria-hidden="true">${short}</span> <span aria-hidden="true">↗</span></a>`;
  const rail = html`<div class="toc-label">Kestrel</div>${out("https://getkestrel.dev", "Project site", "Project")}${
    repoUrl
      ? [out(repoUrl, "Source on GitHub", "Source"), out(`${repoUrl}/blob/HEAD/LICENSE`, "License")]
      : null
  }`;
  setHtml(app, roomShell("docs", rail, main));
  window.scrollTo(0, 0);
}

// One doc, deep-linked by slug. The rail is this doc's "On this page" (scroll-spy-tracked)
// — never a list of the other docs. Sequential Prev/Next sits on the title line (compact)
// and at the foot of the article (with titles), not in the rail.
//
// The rail folds on mobile: "On this page" is a <details> that is open on desktop (where
// the summary is inert — it just looks like the label) and closed on mobile, where it is
// one tappable row above the article and closes again once a section is picked. The state
// follows the layout, not the width at render time: crossing 720px (a rotation, a resized
// window) re-opens it on desktop — where nothing else could, the summary being inert —
// and takes the summary out of the tab order there, so a keyboard user can't collapse a
// list no pointer can reopen. One listener for the app's lifetime; it finds the fold that
// is in the DOM, if any.
const mobileMq = matchMedia("(max-width: 720px)");
function syncFold(fold: HTMLDetailsElement | null): void {
  if (!fold) {
    return;
  }
  const mobile = mobileMq.matches;
  fold.open = !mobile;
  $("summary", fold).tabIndex = mobile ? 0 : -1;
}
// The fold is only in the DOM on a doc page, so a nullable lookup is the right one here.
const findFold = () => document.querySelector<HTMLDetailsElement>("details#tocOnPage");
mobileMq.addEventListener("change", () => syncFold(findFold()));

interface DocSection {
  id: string;
  title: string;
}

function renderDocPage(docs: DocFragment[], slug: string): void {
  const at = docs.findIndex((d) => d.slug === slug);
  const cur = docs[at];
  if (!cur) {
    // A stale or renamed deep link shouldn't masquerade as a doc — heal to the index.
    toast(`No doc named “${slug}” — showing the index.`);
    history.replaceState(history.state, "", "#/docs");
    renderDocsIndex(docs);
    return;
  }
  const prev = docs[at - 1];
  const next = docs[at + 1];
  // Compact Prev/Next on the title line, right of the H1 — no titles (the foot pager
  // carries those; each link's aria-label names its target). On mobile the words drop
  // and the arrows alone remain, so the row still fits beside a wrapping title.
  const topLink = (doc: DocFragment, dir: "Previous" | "Next"): Html =>
    html`<a href="#/docs/${doc.slug}" aria-label="${dir}: ${doc.title}">${
      dir === "Previous"
        ? html`<span aria-hidden="true">←</span><span class="doc-topnav-word">Previous</span>`
        : html`<span class="doc-topnav-word">Next</span><span aria-hidden="true">→</span>`
    }</a>`;
  const topNav =
    prev || next
      ? html`<nav class="doc-topnav" aria-label="Adjacent docs">${prev ? topLink(prev, "Previous") : null}${next ? topLink(next, "Next") : null}</nav>`
      : null;
  // The rail gets a slot, filled once the sections are known (below) — the slot, not the
  // whole rail, so the build stamp roomShell set under it stays.
  setHtml(
    app,
    roomShell(
      "docs",
      html`<div id="docToc"></div>`,
      html`<article class="doc" id="docsMain"></article>`,
    ),
  );
  const navEl = $("#docToc");
  const mainEl = $("#docsMain");
  // The API's rendered HTML: the repo's own Markdown, hygiene-passed by the Worker.
  setHtml(
    mainEl,
    html`<section class="doc-part" id="doc-${cur.slug}">${unsafeHtml(cur.html)}</section>`,
  );

  // The fragment carries no ids — assign them to the current part's H1 and its H2s, and
  // collect the sections for "On this page". The H1 leads so there's a way back to the top.
  const sec = $("section.doc-part", mainEl);
  const h1 = sec.querySelector("h1");
  const sections: DocSection[] = [];
  if (h1) {
    h1.id = `part-${cur.slug}`;
    sections.push({ id: h1.id, title: h1.textContent || cur.title });
  }
  // Put the H1 and the compact pager on one line: wrap the fragment's own H1 in a title
  // row and set the pager beside it (the H1 stays the doc's H1 — same node, same id).
  if (topNav) {
    const head = document.createElement("div");
    head.className = "doc-head";
    setHtml(head, topNav);
    if (h1) {
      h1.before(head);
      head.prepend(h1);
    } else {
      sec.prepend(head);
    }
  }
  for (const [i, h2] of $$<HTMLHeadingElement>("h2", sec).entries()) {
    const id = `sec-${cur.slug}-${i + 1}`;
    h2.id = id;
    sections.push({ id, title: h2.textContent || "" });
  }

  // Previous / Next at the foot — with titles, the sequential path through the guide.
  const pager = document.createElement("nav");
  pager.className = "doc-pager";
  setHtml(
    pager,
    html`${
      prev
        ? html`<a class="doc-pager-btn prev" href="#/docs/${prev.slug}"><span class="doc-pager-dir">← Previous</span><span class="doc-pager-title">${prev.title}</span></a>`
        : html`<span></span>`
    }${
      next
        ? html`<a class="doc-pager-btn next" href="#/docs/${next.slug}"><span class="doc-pager-dir">Next →</span><span class="doc-pager-title">${next.title}</span></a>`
        : html`<span></span>`
    }`,
  );
  mainEl.appendChild(pager);

  // Rail: this doc's "On this page" only (scroll-spy-tracked). No back-link (the "Docs" tab
  // returns to the index) and no rail pager (Prev/Next is the title line + the article
  // foot). A <details>, open unless this is mobile (the header comment says why).
  const onPage = sections.map(
    (s) => html`<a class="toc-sub" href="#${s.id}" data-target="${s.id}">${s.title}</a>`,
  );
  setHtml(
    navEl,
    sections.length
      ? html`<details class="toc-onpage" id="tocOnPage"><summary class="toc-label">On this page</summary>${onPage}</details>`
      : html``,
  );

  // "On this page" links jump within the current doc and highlight at once. On mobile the
  // fold closes first, so the page height above the target is settled before the scroll
  // is measured.
  const onPageEl = findFold();
  syncFold(onPageEl); // open + inert on desktop, closed + tappable on mobile (before paint)
  const markActive = (id: string) => {
    if (!onPageEl) {
      return;
    }
    for (const a of $$(".toc-sub", onPageEl)) {
      a.classList.toggle("on", a.dataset.target === id);
    }
  };
  navEl.addEventListener("click", (ev) => {
    const a =
      ev.target instanceof Element ? ev.target.closest<HTMLElement>("a[data-target]") : null;
    const target = a?.dataset.target;
    if (!target) {
      return;
    }
    ev.preventDefault();
    markActive(target);
    if (onPageEl && mobileMq.matches) {
      onPageEl.open = false;
    }
    document.getElementById(target)?.scrollIntoView({ block: "start" });
  });

  // Copy buttons on the guide's shell / DNS code blocks.
  for (const pre of $$<HTMLPreElement>("pre", mainEl)) {
    pre.classList.add("has-copy");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      try {
        await navigator.clipboard.writeText((code || pre).innerText);
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      } catch {
        toast("Couldn't copy to clipboard");
      }
    });
    pre.appendChild(btn);
  }

  // Scroll-spy: the active section is the last heading scrolled above a line just under the
  // sticky room bar; at the bottom the last heading wins so a short final section still
  // highlights. One document.onscroll slot, self-cleared once this doc leaves the DOM.
  const ids = sections.map((s) => s.id);
  const first = ids[0];
  if (onPageEl && first) {
    const last = ids[ids.length - 1] ?? first;
    // Just under the sticky bar. Measured, not assumed: the bar is --bar-h at every width
    // (see roomShell), but large-text zoom can push it taller, and the spy should follow.
    const barH = document.querySelector(".room-bar")?.getBoundingClientRect().height || 54;
    const line = barH + 26;
    const spy = () => {
      if (!document.getElementById(first)) {
        document.onscroll = null;
        return;
      }
      let active = first;
      if (Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight) {
        active = last;
      } else {
        for (const id of ids) {
          if (
            (document.getElementById(id)?.getBoundingClientRect().top ??
              Number.POSITIVE_INFINITY) <= line
          ) {
            active = id;
          } else {
            break;
          }
        }
      }
      markActive(active);
    };
    document.onscroll = spy;
    spy();
  }

  // Each doc is its own page — start at the top.
  window.scrollTo(0, 0);
}
