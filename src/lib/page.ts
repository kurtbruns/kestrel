/** HTML for the reader-facing routes: small card pages (confirm, unsubscribe,
 *  invalid-link) via `htmlPage`, and the branded reader shell (`readerPage`) behind
 *  the landing page, the archive index, and the subscribe flow. Automatic light/dark
 *  via prefers-color-scheme. */
import { escapeHtml, escapeHtmlAttr } from "./html";

/** Color tokens + resets shared by every reader page. */
const TOKENS = `
:root {
  color-scheme: light dark;
  --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --bg:#f4f4f5; --card:#fff;
  --accent:#18181b; --accent-fg:#fff; --danger:#b91c1c; --danger-fg:#fff;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --fg:#ededed; --muted:#a1a1aa; --line:#2e2e33; --bg:#18181b; --card:#232327;
          --accent:#e5e7eb; --accent-fg:#18181b; --danger:#f87171; --danger-fg:#18181b; }
}
* { box-sizing: border-box; }
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--fg); }
a { color: inherit; }
.muted { color: var(--muted); }
`;

const CARD_STYLE = `${TOKENS}
.wrap { max-width:480px; margin:64px auto; padding:32px; background:var(--card);
        border:1px solid var(--line); border-radius:10px; line-height:1.6; }
h1 { margin-top:0; }
input { font:inherit; font-size:16px; padding:10px; width:100%; border:1px solid var(--line);
        border-radius:6px; background:var(--card); color:var(--fg); }
.btn { font:inherit; font-size:16px; margin-top:12px; padding:10px 18px; border-radius:6px;
       border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); cursor:pointer; }
.btn:hover { filter: brightness(1.08); }
.btn:active { transform: translateY(1px); }
.btn-danger { border-color:var(--danger); background:var(--danger); color:var(--danger-fg); }
.btn:focus-visible, input:focus-visible, a:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
.wrap p a { text-decoration: underline; }
@media (prefers-color-scheme: dark) { .btn:focus-visible, input:focus-visible, a:focus-visible { outline-color:#60a5fa; } }
`;

export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CARD_STYLE}</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
  return new Response(doc, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

/* The reader surface (§5): the public landing page at `/` and the full archive
   index at the archive base path. Both wear the publication's identity — a light
   masthead over an editorial serif — deliberately not the neutral zinc admin
   chrome. Indexable (no noindex) and linking only to public pages, never into the
   Access-gated admin surface (§11). */

/** The reader ground — shared by the chrome pages here and injected onto the hosted
 *  post page (see `ARCHIVE_POST_HEAD`), so the whole publication sits on one
 *  background in each theme. The sent email keeps its own white; this is web-only. */
const READER_BG_LIGHT = "#fbfbfa";
const READER_BG_DARK = "#12110f";

const READER_STYLE = `
:root {
  color-scheme: light dark;
  --r-bg:${READER_BG_LIGHT}; --r-ink:#1b1a17; --r-card:#ffffff; --r-line:#e7e5df; --r-mut:#6b6a63;
  --r-serif:Fraunces,Georgia,'Iowan Old Style','Times New Roman',serif;
  --r-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --r-measure:820px; /* one reading width shared by the masthead, body, and footer so their edges line up */
  /* The masthead sits on the card surface with a hairline rule (the footer's top
     rule, mirrored); the eyebrow/link accent inherits the ink color. */
  --brand-ink:currentColor;
  /* The app's brand accent (DESIGN.md §3), mirrored here for the ONE dev-only
     element the reader surface carries — the "Open dashboard" pill. That badge is
     app chrome, not the publication's identity, so it wears the app's action color
     rather than the reader ink; keep these values in sync with styles.css. This is
     the single, deliberate exception to "the reader surface is not styled from the
     admin tokens" (DESIGN.md, reader-surface note). */
  --k-accent:#3355cc; --k-accent-contrast:#ffffff;
}
@media (prefers-color-scheme: dark) {
  :root { --r-bg:${READER_BG_DARK}; --r-ink:#ece9e3; --r-card:#1b1a17; --r-line:#2c2a25; --r-mut:#a5a199;
          --k-accent:#7d9bff; --k-accent-contrast:#10131f; }
}
* { box-sizing:border-box; }
body { margin:0; font-family:var(--r-sans); background:var(--r-bg); color:var(--r-ink); line-height:1.6; }
a { color:inherit; }
img { max-width:100%; }

/* Masthead: identity + a subscribe call to action, on the card surface with a
   hairline bottom rule — light with dark text in light mode, and it inverts with
   the reader tokens in dark mode. */
.r-mast { background:var(--r-card); color:var(--r-ink); border-bottom:1px solid var(--r-line); }
.r-mast-in { max-width:var(--r-measure); margin:0 auto; padding:24px; display:flex; align-items:center; gap:16px; }
.r-brand { display:flex; align-items:center; gap:14px; text-decoration:none; color:inherit; min-width:0; }
.r-logo { width:64px; height:64px; border-radius:14px; background:color-mix(in srgb, currentColor 12%, transparent);
          flex:none; display:grid; place-items:center; overflow:hidden; }
.r-logo img { max-width:100%; max-height:100%; display:block; }
.r-name { font-family:var(--r-serif); font-size:23px; font-weight:600; letter-spacing:-.01em; line-height:1.15; }
.r-tag { font-size:13px; opacity:.85; margin-top:2px; }
.r-cta { margin-left:auto; flex:none; }
.r-sub { display:inline-flex; align-items:center; gap:6px; font-size:13.5px; font-weight:600; color:inherit;
         text-decoration:none; border:1px solid color-mix(in srgb, currentColor 45%, transparent);
         padding:8px 14px; border-radius:999px; white-space:nowrap; }
.r-sub:hover { background:color-mix(in srgb, currentColor 14%, transparent); }

.r-body { max-width:var(--r-measure); margin:0 auto; padding:32px 24px 56px; }
.r-ey { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--brand-ink);
        font-weight:700; margin:0 0 12px; }
.r-feat { border:1px solid var(--r-line); background:var(--r-card); border-radius:12px; padding:22px 24px; margin:0 0 1.5rem; }
.r-feat .r-k { font-size:12.5px; color:var(--r-mut); margin:0 0 8px; }
.r-feat h2 { font-family:var(--r-serif); font-size:26px; line-height:1.15; font-weight:600; margin:0 0 12px; }
.r-feat h2 a { text-decoration:none; }
.r-feat h2 a:hover { text-decoration:underline; }
.r-link { font-size:14px; font-weight:600; color:var(--brand-ink); text-decoration:none; }
.r-link:hover { text-decoration:underline; }
ul.r-list { list-style:none; margin:0; padding:0; }
li.r-item { display:flex; gap:18px; align-items:baseline; padding:16px 0; border-top:1px solid var(--r-line); }
/* Fixed date column so the titles line up. Sized to hold the widest en-US long date
   ("September 30, 2026" ≈ 122px) — a narrower column lets a long month overflow its
   box (flex:none + nowrap don't clip) and butt against the title. */
li.r-item .r-d { font-size:12.5px; color:var(--r-mut); width:128px; flex:none; white-space:nowrap; }
a.r-t { font-family:var(--r-serif); font-size:18px; font-weight:600; text-decoration:none; }
a.r-t:hover { text-decoration:underline; }
.r-empty { color:var(--r-mut); padding:20px 0; }
.r-arch { display:inline-block; margin-top:24px; font-size:14px; font-weight:600; color:var(--brand-ink); text-decoration:none; }
.r-arch:hover { text-decoration:underline; }

/* Subscribe / message pages: a headline, lede, and a branded form. */
.r-h1 { font-family:var(--r-serif); font-size:30px; line-height:1.12; font-weight:600; letter-spacing:-.01em; margin:0 0 12px; }
.r-lead { font-size:16px; color:var(--r-mut); margin:0 0 22px; max-width:54ch; }
.r-form { display:flex; gap:10px; flex-wrap:wrap; max-width:460px; }
.r-form input { flex:1 1 220px; font:inherit; font-size:16px; padding:11px 13px; border:1px solid var(--r-line);
                border-radius:9px; background:var(--r-card); color:var(--r-ink); }
.r-form input:focus-visible { outline:2px solid var(--brand-ink); outline-offset:1px; border-color:var(--brand-ink); }
.r-btn { font:inherit; font-size:15px; font-weight:600; padding:11px 20px; border-radius:9px; border:1px solid var(--r-ink);
         background:var(--r-ink); color:var(--r-bg); cursor:pointer; white-space:nowrap; }
.r-btn:hover { filter:brightness(1.06); }
.r-fine { font-size:12.5px; color:var(--r-mut); margin:16px 0 0; }

.r-foot { border-top:1px solid var(--r-line); }
.r-foot-in { max-width:var(--r-measure); margin:0 auto; padding:22px 24px 40px; font-size:12.5px; color:var(--r-mut); }

/* Dev-only affordance (SPEC §5/§11): a fixed corner pill that hops a local
   developer into the editor. Shown solely on a dev-shaped instance and rendered as
   over-the-page dev chrome — deliberately not the publication's own identity — so
   it reads as tooling, never as part of the reader surface. Absent once deployed.
   It wears the app's brand accent (--k-accent, DESIGN.md §3), matching a Primary
   action, so a shortcut INTO the app reads as the app — not the reader's ink. */
.r-dev { position:fixed; right:18px; bottom:18px; z-index:50; display:inline-flex; align-items:center; gap:8px;
         font-size:13px; font-weight:600; text-decoration:none; padding:9px 15px 9px 10px; border-radius:999px;
         background:var(--k-accent); color:var(--k-accent-contrast); border:1px solid var(--k-accent);
         box-shadow:0 6px 20px rgba(0,0,0,.22); }
.r-dev:hover { filter:brightness(1.08); }
/* Inverted badge — solid contrast fill, accent-colored text — so the tiny "DEV"
   label clears WCAG AA on the accent pill in both themes (a translucent tint left
   it ~3.6:1). */
.r-dev .r-dev-tag { font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; font-weight:700;
                    padding:2px 7px; border-radius:999px;
                    background:var(--k-accent-contrast); color:var(--k-accent); }

a:focus-visible, .r-sub:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media (prefers-color-scheme: dark) { a:focus-visible, .r-sub:focus-visible { outline-color:#60a5fa; } }
@media (max-width:560px) {
  .r-mast-in { flex-wrap:wrap; gap:12px; }
  .r-cta { margin-left:0; }
  li.r-item { flex-wrap:wrap; gap:6px 18px; }
  li.r-item .r-d { width:100%; }
}
`;

/** Stylesheet links for the publication's display serif (Fraunces), loaded on the
 *  hosted reader pages and injected into the archive post page's <head> (browser-
 *  only chrome, never the email). Only the allowed Google Fonts hosts are used. */
export const FRAUNCES_FONT_LINKS =
  `<link rel="preconnect" href="https://fonts.googleapis.com">` +
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400..600&display=swap">`;

/** Everything the archive route injects into a hosted post page's <head> at the
 *  reserved anchor: the display-serif links, the frozen render's background, and the
 *  browser-only masthead's colors (`.k-mast`, see `archiveMasthead`) — both themed
 *  light/dark here so the whole page turns together.
 *
 *  Two kinds of rule live here, and the difference is deliberate. The background
 *  targets `.k-bg` / `.k-card`, which are real email content the layout sets *inline*
 *  (an email needs inline styles); overriding an inline style takes `!important` (plus
 *  the `body …` prefix for specificity). The masthead is browser-only and carries no
 *  inline color, so it's a plain rule — light value, then a dark `@media` override,
 *  no `!important` needed. Its text is the email's muted zinc, lifted in dark to
 *  `#a1a1aa` (~7:1 on the reader ground; the light `#71717a` was ~3.9:1 there). */
export const ARCHIVE_POST_HEAD =
  FRAUNCES_FONT_LINKS +
  `<style>body.k-bg,body .k-bg,body .k-card{background:${READER_BG_LIGHT}!important}` +
  `.k-mast{color:#71717a;border-bottom:1px solid #e4e4e7}` +
  `@media(prefers-color-scheme:dark){body.k-bg,body .k-bg,body .k-card{background:${READER_BG_DARK}!important}` +
  `.k-mast{color:#a1a1aa;border-bottom-color:#2e2e33}}</style>`;

/** One post as the reader surface lists it: its title, its archive URL, and a display date. */
export interface ArchiveIndexPost {
  title: string;
  url: string;
  dateLabel: string;
}

/** The publication identity the reader chrome renders. */
export interface ReaderIdentity {
  name: string;
  tagline?: string;
  logoUrl?: string;
}

/** The dev-only editor shortcut (SPEC §5/§11): a fixed corner pill linking a local
 *  developer straight into `/dashboard`. Rendered only when `url` is set — the
 *  callers pass it solely on a dev-shaped instance (`config.devMode`), where
 *  `/dashboard` carries no Access wall — so it is structurally absent once deployed
 *  and never turns the public front door into a link toward the admin gate. */
function devDashboardBadge(url?: string): string {
  // The "DEV" chip flags it as tooling; the title spells out the scope for anyone
  // who wonders whether it ships — it never does (see the doc above).
  return url
    ? `<a class="r-dev" href="${escapeHtmlAttr(url)}" title="Shown only on your local dev server"><span class="r-dev-tag">Dev</span>Open dashboard &rarr;</a>`
    : "";
}

/** The shared reader shell: a brand masthead (identity, plus a "Subscribe here →"
 *  call to action when `subscribeUrl` is given) and a footer, wrapping page-specific
 *  `mainHtml`. Public + indexable; every link points only at public pages (§11). */
export function readerPage(opts: {
  identity: ReaderIdentity;
  homeUrl: string;
  title: string;
  mainHtml: string;
  /** When set, the masthead shows the subscribe CTA linking here. Omitted on the
   *  subscribe pages themselves, where the CTA would point at the current page. */
  subscribeUrl?: string;
  /** Dev-only: the `/dashboard` URL for the local-developer shortcut. Passed solely
   *  on a dev-shaped instance (§11); omitted — and so hidden — in any deployed env. */
  devDashboardUrl?: string;
  /** HTTP status; defaults to 200 (a rejected subscribe form uses 400). */
  status?: number;
}): Response {
  const { name, tagline, logoUrl } = opts.identity;
  const logo = logoUrl
    ? `<span class="r-logo"><img src="${escapeHtmlAttr(logoUrl)}" alt=""></span>`
    : "";
  const tag = tagline ? `<div class="r-tag">${escapeHtml(tagline)}</div>` : "";
  const cta = opts.subscribeUrl
    ? `<span class="r-cta"><a class="r-sub" href="${escapeHtmlAttr(opts.subscribeUrl)}">Subscribe here &rarr;</a></span>`
    : "";
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${FRAUNCES_FONT_LINKS}
<style>${READER_STYLE}</style>
</head>
<body>
<header class="r-mast"><div class="r-mast-in">
<a class="r-brand" href="${escapeHtmlAttr(opts.homeUrl)}">${logo}<span><span class="r-name">${escapeHtml(name)}</span>${tag}</span></a>
${cta}
</div></header>
<main class="r-body">${opts.mainHtml}</main>
<footer class="r-foot"><div class="r-foot-in">Powered by Kestrel &middot; Unsubscribe anytime &middot; Consent is double opt-in.</div></footer>
${devDashboardBadge(opts.devDashboardUrl)}
</body>
</html>`;
  return new Response(doc, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

function postRow(i: ArchiveIndexPost): string {
  return (
    `<li class="r-item"><span class="r-d">${escapeHtml(i.dateLabel)}</span>` +
    `<a class="r-t" href="${escapeHtmlAttr(i.url)}">${escapeHtml(i.title)}</a></li>`
  );
}

/** The public front door (§5): a landing page that features the latest post, lists
 *  a few recent ones, and links into the full archive — never into the admin. */
export function landingPage(opts: {
  identity: ReaderIdentity;
  subscribeUrl: string;
  homeUrl: string;
  archiveUrl: string;
  /** The most recent post, featured; absent when nothing has been sent. */
  featured?: ArchiveIndexPost;
  /** The next-most-recent posts, listed beneath the feature. */
  recent: ArchiveIndexPost[];
  /** Dev-only editor shortcut (§11); set only on a dev-shaped instance. */
  devDashboardUrl?: string;
}): Response {
  let main: string;
  if (!opts.featured) {
    main = `<p class="r-empty">No posts yet — subscribe to get the first one.</p>`;
  } else {
    const f = opts.featured;
    const feature =
      `<p class="r-ey">Latest post</p>` +
      `<article class="r-feat"><p class="r-k">${escapeHtml(f.dateLabel)}</p>` +
      `<h2><a href="${escapeHtmlAttr(f.url)}">${escapeHtml(f.title)}</a></h2>` +
      `<a class="r-link" href="${escapeHtmlAttr(f.url)}">Read here &rarr;</a></article>`;
    const list = opts.recent.length
      ? `<ul class="r-list">${opts.recent.map(postRow).join("")}</ul>`
      : "";
    const archive = `<a class="r-arch" href="${escapeHtmlAttr(opts.archiveUrl)}">Browse the full archive &rarr;</a>`;
    main = feature + list + archive;
  }
  return readerPage({
    identity: opts.identity,
    subscribeUrl: opts.subscribeUrl,
    homeUrl: opts.homeUrl,
    title: opts.identity.name,
    mainHtml: main,
    devDashboardUrl: opts.devDashboardUrl,
  });
}

/** The full public archive: every sent post, newest first (§5). Reached from the
 *  landing page's "Browse the full archive" link; served at the archive base path. */
export function archiveIndexPage(opts: {
  identity: ReaderIdentity;
  subscribeUrl: string;
  homeUrl: string;
  posts: ArchiveIndexPost[];
  /** Dev-only editor shortcut (§11); set only on a dev-shaped instance. */
  devDashboardUrl?: string;
}): Response {
  const list = opts.posts.length
    ? `<ul class="r-list">${opts.posts.map(postRow).join("")}</ul>`
    : `<p class="r-empty">No posts yet.</p>`;
  return readerPage({
    identity: opts.identity,
    subscribeUrl: opts.subscribeUrl,
    homeUrl: opts.homeUrl,
    title: `Archive · ${opts.identity.name}`,
    mainHtml: `<p class="r-ey">Archive</p>${list}`,
    devDashboardUrl: opts.devDashboardUrl,
  });
}

// The setup guide and the API reference are both rendered natively by
// the admin SPA from JSON the authed `/api/docs` and `/api/reference` routes return
// (see src/docs/, src/reference/, and public/dashboard/app.js) — long-form prose is
// styled by the SPA's own `.doc` block, so there is no server-rendered docs page.
