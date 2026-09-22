// @ts-nocheck
// The in-app docs room: the setup guide fetched from the authed /api/docs routes.

import { api } from "./api";
import { esc, toast } from "./helpers";
import { roomShell } from "./icons";
import { renderError } from "./notice";
import { app } from "./shell";
import { appState } from "./state";

// The setup guide, authored in docs/setup/*.md and served read-only by the authed
// GET /api/docs route as sanitized HTML fragments. `#/docs` is the index — an intro over a
// numbered list of every doc; `#/docs/:slug` is one doc, its rail a back-link to the index
// plus that doc's "On this page" (never a tree of all docs). No iframe: the content is
// trusted (repo markdown, hygiene-passed), so injecting the fragments is safe. Fetched once
// and cached (the bundle never changes at runtime), so paging is instant.
let docsCache = null;

// A doc card's blurb on the index: the doc's own first paragraph, condensed. Derived here
// (docs carry no front-matter description) so it stays in sync with the doc itself.
function docDescription(doc) {
  const tmp = document.createElement("div");
  tmp.innerHTML = doc.html || "";
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

export async function renderDocs(slug) {
  app.innerHTML = roomShell(
    "docs",
    null,
    `<div class="docs-index"><p class="muted">Loading…</p></div>`,
  );
  if (!docsCache) {
    // The first visit fetches; everything below rewrites the whole view, so if the route
    // moved on while the request was in flight (a tap on API, or a different doc), this
    // render is stale and must not paint over the one that replaced it.
    const wanted = location.hash;
    try {
      ({ docs: docsCache } = await api("/api/docs"));
    } catch (e) {
      if (location.hash === wanted) {
        renderError(document.querySelector(".room-main"), e.message, () => renderDocs(slug));
      }
      return;
    }
    if (location.hash !== wanted) {
      return;
    }
  }
  const docs = docsCache;
  if (!docs?.length) {
    const el = document.querySelector(".room-main");
    if (el) {
      el.innerHTML = `<p class="muted">No documentation.</p>`;
    }
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
function renderDocsIndex(docs) {
  const cards = docs
    .map((d, i) => {
      const desc = docDescription(d);
      return (
        `<li><a class="doc-card" href="#/docs/${esc(d.slug)}">` +
        `<span class="doc-card-n">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="doc-card-main">` +
        `<span class="doc-card-t">${esc(d.title)} <span class="doc-card-go" aria-hidden="true">→</span></span>` +
        (desc ? `<span class="doc-card-d">${esc(desc)}</span>` : "") +
        `</span></a></li>`
      );
    })
    .join("");
  const main =
    `<div class="docs-index">` +
    `<p class="eyebrow">Documentation</p>` +
    `<h1>Set up &amp; operate Kestrel</h1>` +
    `<p class="docs-index-intro">How to take a fresh instance to a live newsletter — the run-once, out-of-band steps against your own Cloudflare account, DNS, and email provider.</p>` +
    `<ol class="doc-cards">${cards}</ol>` +
    `</div>`;
  // Three uniform out-links under a "Kestrel" label — the same shape as the API rail's
  // label + tiers, so mobile can give both the same chip row. getkestrel.dev is the
  // project's home, the same for every instance, so it's a constant; the source and
  // license links are the deploy's own repo (package.json → build stamp), so they're
  // absent when no repo is known.
  // Each link carries a short form for the mobile chip row (styles.css swaps which span
  // shows); the full label stays the accessible name at every width.
  const repoUrl = appState.appConfig?.deployment?.build?.repoUrl || "";
  const out = (href, label, short = label) =>
    `<a class="rail-link" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(label)}">` +
    `<span class="rail-link-full">${esc(label)}</span><span class="rail-link-short" aria-hidden="true">${esc(short)}</span>` +
    ` <span aria-hidden="true">↗</span></a>`;
  const rail =
    `<div class="toc-label">Kestrel</div>` +
    out("https://getkestrel.dev", "Project site", "Project") +
    (repoUrl
      ? out(repoUrl, "Source on GitHub", "Source") + out(`${repoUrl}/blob/HEAD/LICENSE`, "License")
      : "");
  app.innerHTML = roomShell("docs", rail, main);
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
function syncFold(fold) {
  if (!fold) {
    return;
  }
  const mobile = mobileMq.matches;
  fold.open = !mobile;
  fold.querySelector("summary").tabIndex = mobile ? 0 : -1;
}
mobileMq.addEventListener("change", () => syncFold(document.getElementById("tocOnPage")));
function renderDocPage(docs, slug) {
  const at = docs.findIndex((d) => d.slug === slug);
  if (at === -1) {
    // A stale or renamed deep link shouldn't masquerade as a doc — heal to the index.
    toast(`No doc named “${slug}” — showing the index.`);
    history.replaceState(history.state, "", "#/docs");
    renderDocsIndex(docs);
    return;
  }
  const cur = docs[at];
  const prev = docs[at - 1];
  const next = docs[at + 1];
  // Compact Prev/Next on the title line, right of the H1 — no titles (the foot pager
  // carries those; each link's aria-label names its target). On mobile the words drop
  // and the arrows alone remain, so the row still fits beside a wrapping title.
  const topLink = (doc, dir) =>
    `<a href="#/docs/${esc(doc.slug)}" aria-label="${esc(`${dir}: ${doc.title}`)}">` +
    (dir === "Previous"
      ? `<span aria-hidden="true">←</span><span class="doc-topnav-word">Previous</span>`
      : `<span class="doc-topnav-word">Next</span><span aria-hidden="true">→</span>`) +
    `</a>`;
  const topNav =
    prev || next
      ? `<nav class="doc-topnav" aria-label="Adjacent docs">${prev ? topLink(prev, "Previous") : ""}${next ? topLink(next, "Next") : ""}</nav>`
      : "";
  // The rail gets a slot, filled once the sections are known (below) — the slot, not the
  // whole rail, so the build stamp roomShell set under it stays.
  app.innerHTML = roomShell(
    "docs",
    `<div id="docToc"></div>`,
    `<article class="doc" id="docsMain"></article>`,
  );
  const navEl = document.getElementById("docToc");
  const mainEl = document.getElementById("docsMain");
  mainEl.innerHTML = `<section class="doc-part" id="doc-${esc(cur.slug)}">${cur.html}</section>`;

  // The fragment carries no ids — assign them to the current part's H1 and its H2s, and
  // collect the sections for "On this page". The H1 leads so there's a way back to the top.
  const sec = mainEl.querySelector("section.doc-part");
  const h1 = sec.querySelector("h1");
  const sections = [];
  if (h1) {
    h1.id = `part-${cur.slug}`;
    sections.push({ id: h1.id, title: h1.textContent || cur.title });
  }
  // Put the H1 and the compact pager on one line: wrap the fragment's own H1 in a title
  // row and set the pager beside it (the H1 stays the doc's H1 — same node, same id).
  if (topNav) {
    const head = document.createElement("div");
    head.className = "doc-head";
    if (h1) {
      h1.before(head);
      head.append(h1);
    } else {
      sec.prepend(head);
    }
    head.insertAdjacentHTML("beforeend", topNav);
  }
  sec.querySelectorAll("h2").forEach((h2, i) => {
    const id = `sec-${cur.slug}-${i + 1}`;
    h2.id = id;
    sections.push({ id, title: h2.textContent || "" });
  });

  // Previous / Next at the foot — with titles, the sequential path through the guide.
  const pager = document.createElement("nav");
  pager.className = "doc-pager";
  pager.innerHTML =
    (prev
      ? `<a class="doc-pager-btn prev" href="#/docs/${esc(prev.slug)}"><span class="doc-pager-dir">← Previous</span><span class="doc-pager-title">${esc(prev.title)}</span></a>`
      : `<span></span>`) +
    (next
      ? `<a class="doc-pager-btn next" href="#/docs/${esc(next.slug)}"><span class="doc-pager-dir">Next →</span><span class="doc-pager-title">${esc(next.title)}</span></a>`
      : `<span></span>`);
  mainEl.appendChild(pager);

  // Rail: this doc's "On this page" only (scroll-spy-tracked). No back-link (the "Docs" tab
  // returns to the index) and no rail pager (Prev/Next is the title line + the article
  // foot). A <details>, open unless this is mobile (the header comment says why).
  const onPage = sections
    .map(
      (s) =>
        `<a class="toc-sub" href="#${esc(s.id)}" data-target="${esc(s.id)}">${esc(s.title)}</a>`,
    )
    .join("");
  navEl.innerHTML = sections.length
    ? `<details class="toc-onpage" id="tocOnPage"><summary class="toc-label">On this page</summary>${onPage}</details>`
    : "";

  // "On this page" links jump within the current doc and highlight at once. On mobile the
  // fold closes first, so the page height above the target is settled before the scroll
  // is measured.
  const onPageEl = document.getElementById("tocOnPage");
  syncFold(onPageEl); // open + inert on desktop, closed + tappable on mobile (before paint)
  const markActive = (id) => {
    if (!onPageEl) {
      return;
    }
    for (const a of onPageEl.querySelectorAll(".toc-sub")) {
      a.classList.toggle("on", a.dataset.target === id);
    }
  };
  navEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-target]");
    if (!a) {
      return;
    }
    ev.preventDefault();
    markActive(a.dataset.target);
    if (onPageEl && mobileMq.matches) {
      onPageEl.open = false;
    }
    document.getElementById(a.dataset.target)?.scrollIntoView({ block: "start" });
  });

  // Copy buttons on the guide's shell / DNS code blocks.
  for (const pre of mainEl.querySelectorAll("pre")) {
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
  if (onPageEl && sections.length) {
    const ids = sections.map((s) => s.id);
    // Just under the sticky bar. Measured, not assumed: the bar is --bar-h at every width
    // (see roomShell), but large-text zoom can push it taller, and the spy should follow.
    const barH = document.querySelector(".room-bar")?.getBoundingClientRect().height || 54;
    const line = barH + 26;
    const spy = () => {
      if (!document.getElementById(ids[0])) {
        document.onscroll = null;
        return;
      }
      let active = ids[0];
      if (Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight) {
        active = ids[ids.length - 1];
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
