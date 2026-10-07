// The in-app docs room: the setup guide fetched from the authed /api/docs routes.

import type { DocFragment, DocsLanding, DocsResponse } from "../../shared/docs";
import { api } from "../api";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { $, $$ } from "../ui/dom";
import { type Html, html, setHtml, unsafeHtml } from "../ui/html";
import { renderError, toast } from "../ui/widgets";
import { roomShell } from "./shell";

// The setup guide, authored in docs/README.md and its section folders, and served read-only by the authed
// GET /api/docs route as sanitized HTML fragments. `#/docs` is the index — an intro over the
// guide's sections, the main path numbered as steps; `#/docs/:slug` is one doc, and
// `#/docs/:slug/:anchor` one heading on it; its rail a back-link to the index
// plus that doc's "On this page" (never a tree of all docs). No iframe: the content is
// trusted (repo markdown, hygiene-passed), so injecting the fragments is safe. Fetched once
// and cached (the bundle never changes at runtime), so paging is instant.
let docsCache: DocsResponse | null = null;

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

export async function renderDocs(
  slug: string | undefined,
  root: HTMLElement,
  signal: AbortSignal,
  anchor?: string,
): Promise<void> {
  setHtml(
    root,
    roomShell("docs", null, html`<div class="docs-index"><p class="muted">Loading…</p></div>`),
  );
  if (!docsCache) {
    // The first visit fetches (with the mount's signal, so a tap on API or a different
    // doc while it is in flight cuts it off rather than let it paint a stale room).
    try {
      docsCache = await api<DocsResponse>("/api/docs", { signal });
    } catch (e) {
      if (!signal.aborted) {
        renderError($(".room-main", root), e instanceof Error ? e.message : String(e), () =>
          mount((r, s) => renderDocs(slug, r, s, anchor)),
        );
      }
      return;
    }
  }
  const { landing, docs } = docsCache;
  if (!docs.length) {
    setHtml($(".room-main"), html`<p class="muted">No documentation.</p>`);
    return;
  }
  if (slug) {
    renderDocPage(root, landing, docs, slug, anchor ? decodeAnchor(anchor) : undefined);
  } else {
    renderDocsIndex(root, landing, docs);
  }
}

/** The route's anchor segment as the heading's anchor. A malformed escape in a hand-edited
 *  link opens the page at its top rather than failing the room. */
function decodeAnchor(anchor: string): string | undefined {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return undefined;
  }
}

// The index: the landing page `docs/README.md` lays out (its title, intro, and sections),
// with a card per doc. A section the README lists as numbered shows numbers, since its pages
// are steps taken in order; the others are picked from. The cards' titles and blurbs come
// from the docs themselves. It keeps the
// room's two-column shape (a doc page's rail is that doc's "On this page"); here the rail
// holds the project's external links — the reference room is about Kestrel itself, so this
// is where getkestrel.dev and the source live.
function renderDocsIndex(root: HTMLElement, landing: DocsLanding, docs: DocFragment[]): void {
  const card = (d: DocFragment, n: number | null): Html => {
    const desc = docDescription(d);
    return html`<li><a class="doc-card" href="#/docs/${d.slug}">${n === null ? null : html`<span class="doc-card-n">${String(n).padStart(2, "0")}</span>`}<span class="doc-card-main"><span class="doc-card-t">${d.title} <span class="doc-card-go" aria-hidden="true">→</span></span>${desc ? html`<span class="doc-card-d">${desc}</span>` : null}</span></a></li>`;
  };
  const sections = landing.sections.map((sec) => {
    const inSection = docs.filter((d) => d.section === sec.id);
    if (!inSection.length) {
      return null;
    }
    const cards = inSection.map((d, i) => card(d, sec.numbered ? i + 1 : null));
    // The API's rendered HTML: the README's own blurb, hygiene-passed by the Worker.
    const blurb = sec.blurb
      ? html`<div class="doc-section-blurb">${unsafeHtml(sec.blurb)}</div>`
      : null;
    return html`<section class="doc-section"><h2 class="doc-section-t">${sec.title}</h2>${blurb}${sec.numbered ? html`<ol class="doc-cards">${cards}</ol>` : html`<ul class="doc-cards">${cards}</ul>`}</section>`;
  });
  const main = html`<div class="docs-index"><p class="eyebrow">Documentation</p><h1>${landing.title}</h1><div class="docs-index-intro">${unsafeHtml(landing.intro)}</div>${sections}</div>`;
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
  setHtml(root, roomShell("docs", rail, main));
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
// list no pointer can reopen. One listener for the app's lifetime, registered by the first
// doc page rendered (the view's own, so not boot's); it finds the fold that is in the DOM,
// if any.
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
let foldFollowsLayout = false;
function followLayout(): void {
  if (foldFollowsLayout) {
    return;
  }
  foldFollowsLayout = true;
  mobileMq.addEventListener("change", () => syncFold(findFold()));
}

interface DocSection {
  id: string;
  /** The heading's anchor, the last segment of its route; empty for the title. */
  anchor: string;
  title: string;
}

/** A heading's anchor as GitHub derives it from the heading's text: lowercased, with
 *  punctuation dropped and each space a hyphen. The guide is read on GitHub too, so a link
 *  written against GitHub's anchors (`05-verify.md#7-read-the-logs`) works here unchanged. */
export function headingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

// Element ids carry a prefix, so a heading can never take an id the shell already uses.
const headingId = (anchor: string): string => `doc-h-${anchor}`;

function renderDocPage(
  root: HTMLElement,
  landing: DocsLanding,
  docs: DocFragment[],
  slug: string,
  anchor?: string,
): void {
  const at = docs.findIndex((d) => d.slug === slug);
  const cur = docs[at];
  if (!cur) {
    // A stale or renamed deep link shouldn't masquerade as a doc — heal to the index.
    toast(`No doc named “${slug}” — showing the index.`);
    history.replaceState(history.state, "", "#/docs");
    renderDocsIndex(root, landing, docs);
    return;
  }
  // Prev/Next stay within the doc's section: the main path ends at its last step rather than
  // running on into the guides after it, which are picked from, not read in order.
  const siblings = docs.filter((d) => d.section === cur.section);
  const pos = siblings.indexOf(cur);
  const prev = siblings[pos - 1];
  const next = siblings[pos + 1];
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
    root,
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

  // The fragment carries no ids — give every heading GitHub's anchor for it (a repeat gets
  // GitHub's -1, -2), and collect the H1 and H2s for "On this page". The H1 leads so
  // there's a way back to the top.
  const sec = $("section.doc-part", mainEl);
  const seen = new Map<string, number>();
  for (const h of $$<HTMLHeadingElement>("h1, h2, h3, h4", sec)) {
    const base = headingAnchor(h.textContent || "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.dataset.anchor = n ? `${base}-${n}` : base;
    h.id = headingId(h.dataset.anchor);
  }
  const h1 = sec.querySelector("h1");
  const sections: DocSection[] = [];
  if (h1) {
    sections.push({ id: h1.id, anchor: "", title: h1.textContent || cur.title });
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
  for (const h2 of $$<HTMLHeadingElement>("h2", sec)) {
    sections.push({ id: h2.id, anchor: h2.dataset.anchor || "", title: h2.textContent || "" });
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
    (s) =>
      html`<a class="toc-sub" href="#/docs/${cur.slug}${s.anchor ? `/${s.anchor}` : ""}" data-target="${s.id}">${s.title}</a>`,
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
  followLayout();
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
    // The address names the section, so it can be shared, without a hashchange that would
    // render the page again.
    history.replaceState(history.state, "", a?.getAttribute("href") ?? location.hash);
    document.getElementById(target)?.scrollIntoView({ block: "start" });
  });

  // A link out of the guide (a provider's sign-up page, say) opens beside the app rather
  // than replacing it, so the reader keeps their place in the step they're on.
  for (const a of $$<HTMLAnchorElement>("a[href^='http']", mainEl)) {
    a.target = "_blank";
    a.rel = "noopener";
  }

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

  // Each doc is its own page — start at the top, or at the heading the route names.
  const heading = anchor ? document.getElementById(headingId(anchor)) : null;
  if (heading) {
    heading.scrollIntoView({ block: "start" });
  } else {
    window.scrollTo(0, 0);
  }
}
