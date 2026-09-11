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
   index at the archive base path. Both wear the publication's identity — a
   brand-colored masthead over an editorial serif — deliberately not the neutral
   zinc admin chrome. Indexable (no noindex) and linking only to public pages,
   never into the Access-gated admin surface (§10). */

/** The reader ground — shared by the chrome pages here and injected onto the hosted
 *  issue page (see `ARCHIVE_POST_HEAD`), so the whole publication sits on one
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
  /* Accent for text on the page ground — a brightened brand color, since the raw
     brand is tuned to fill the masthead and reads too dark as small text. Both
     tints are injected per-request; falls back to the ink color when no brand is set. */
  --brand-ink: var(--brand-ink-light, currentColor);
}
@media (prefers-color-scheme: dark) {
  :root { --r-bg:${READER_BG_DARK}; --r-ink:#ece9e3; --r-card:#1b1a17; --r-line:#2c2a25; --r-mut:#a5a199;
          --brand-ink: var(--brand-ink-dark, currentColor); }
}
* { box-sizing:border-box; }
body { margin:0; font-family:var(--r-sans); background:var(--r-bg); color:var(--r-ink); line-height:1.6; }
a { color:inherit; }
img { max-width:100%; }

/* Brand masthead: a filled bar (identity + a subscribe call to action) in both
   themes; --mast-bg/--mast-fg are inlined per-request from the brand color. */
.r-mast { background:var(--mast-bg); color:var(--mast-fg); }
.r-mast-in { max-width:var(--r-measure); margin:0 auto; padding:24px; display:flex; align-items:center; gap:16px; }
.r-brand { display:flex; align-items:center; gap:14px; text-decoration:none; color:inherit; min-width:0; }
.r-logo { width:40px; height:40px; border-radius:9px; background:color-mix(in srgb, var(--mast-fg) 16%, transparent);
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
li.r-item .r-d { font-size:12.5px; color:var(--r-mut); width:104px; flex:none; white-space:nowrap; }
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
.r-btn { font:inherit; font-size:15px; font-weight:600; padding:11px 20px; border-radius:9px; border:1px solid var(--mast-bg);
         background:var(--mast-bg); color:var(--mast-fg); cursor:pointer; white-space:nowrap; }
.r-btn:hover { filter:brightness(1.06); }
.r-fine { font-size:12.5px; color:var(--r-mut); margin:16px 0 0; }

.r-foot { border-top:1px solid var(--r-line); }
.r-foot-in { max-width:var(--r-measure); margin:0 auto; padding:22px 24px 40px; font-size:12.5px; color:var(--r-mut); }

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
 *  hosted reader pages and injected into the archive issue page's <head> (browser-
 *  only chrome, never the email). Only the allowed Google Fonts hosts are used. */
export const FRAUNCES_FONT_LINKS =
  `<link rel="preconnect" href="https://fonts.googleapis.com">` +
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400..600&display=swap">`;

/** Everything the archive route injects into a hosted issue page's <head> at the
 *  reserved anchor: the display-serif links, plus a background override that lands
 *  the frozen email render on the same ground as the reader chrome. The selectors
 *  outrank the email layout's own `.k-bg` / `.k-card` rules (higher specificity +
 *  !important), so the match holds in light and dark whatever the source order. */
export const ARCHIVE_POST_HEAD =
  FRAUNCES_FONT_LINKS +
  `<style>body.k-bg,body .k-bg,body .k-card{background:${READER_BG_LIGHT}!important}` +
  `@media(prefers-color-scheme:dark){body.k-bg,body .k-bg,body .k-card{background:${READER_BG_DARK}!important}}</style>`;

/** One issue as the reader surface lists it: its title, its archive URL, and a display date. */
export interface ArchiveIndexIssue {
  title: string;
  url: string;
  dateLabel: string;
}

/** The publication identity the reader chrome renders. `brandColor` is a stored
 *  `#rrggbb` (or ""); a non-hex value falls back to the neutral accent. */
export interface ReaderIdentity {
  name: string;
  tagline?: string;
  logoUrl?: string;
  brandColor?: string;
}

/** Masthead fill + a readable text color for it. A strict `#rrggbb` brand color
 *  fills the bar; anything else falls back to the near-black admin accent — so the
 *  value inlined into the stylesheet is always a safe literal, never attacker text. */
function mastheadColors(brandColor?: string): { bg: string; fg: string } {
  const bg = /^#[0-9a-f]{6}$/.test(brandColor ?? "") ? (brandColor as string) : "#18181b";
  const h = bg.slice(1);
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { bg, fg: luminance > 0.6 ? "#111111" : "#ffffff" };
}

/** Mix a `#rrggbb` toward white by `amount` (0–1) — brightens the brand color for
 *  use as accent text on the light page ground, where the raw brand reads too dark. */
function lighten(hex: string, amount: number): string {
  const h = hex.slice(1);
  const channel = (i: number): string => {
    const c = Number.parseInt(h.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/** `#rrggbb` → HSL (h in [0,360), s/l in [0,1]). */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = hex.slice(1);
  const r = Number.parseInt(n.slice(0, 2), 16) / 255;
  const g = Number.parseInt(n.slice(2, 4), 16) / 255;
  const b = Number.parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (raw * 60 + 360) % 360, s, l };
}

/** HSL (h in [0,360), s/l in [0,1]) → `#rrggbb`. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(h / 60) % 6] as [number, number, number];
  const to = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** The brand accent for dark mode: lift lightness so it reads on the near-black
 *  ground, but keep it saturated — mixing toward white (as the light accent does)
 *  washes the color out, so this works in HSL instead. */
function darkAccent(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.min(0.9, Math.max(0.3, s * 0.8)), Math.min(0.62, l + 0.28));
}

/** The shared reader shell: a brand masthead (identity, plus a "Subscribe here →"
 *  call to action when `subscribeUrl` is given) and a footer, wrapping page-specific
 *  `mainHtml`. Public + indexable; every link points only at public pages (§10). */
export function readerPage(opts: {
  identity: ReaderIdentity;
  homeUrl: string;
  title: string;
  mainHtml: string;
  /** When set, the masthead shows the subscribe CTA linking here. Omitted on the
   *  subscribe pages themselves, where the CTA would point at the current page. */
  subscribeUrl?: string;
  /** HTTP status; defaults to 200 (a rejected subscribe form uses 400). */
  status?: number;
}): Response {
  const { name, tagline, logoUrl, brandColor } = opts.identity;
  const { bg, fg } = mastheadColors(brandColor);
  // Only a strict hex is inlined, so a stored value can't escape the <style>. The
  // brand fills the masthead; a brightened tint (more in dark mode) is the accent
  // for eyebrow/links on the page ground.
  const brandVar = /^#[0-9a-f]{6}$/.test(brandColor ?? "")
    ? `--brand-ink-light:${lighten(brandColor as string, 0.18)};--brand-ink-dark:${darkAccent(brandColor as string)};`
    : "";
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
<style>${READER_STYLE}:root{--mast-bg:${bg};--mast-fg:${fg};${brandVar}}</style>
</head>
<body>
<header class="r-mast"><div class="r-mast-in">
<a class="r-brand" href="${escapeHtmlAttr(opts.homeUrl)}">${logo}<span><span class="r-name">${escapeHtml(name)}</span>${tag}</span></a>
${cta}
</div></header>
<main class="r-body">${opts.mainHtml}</main>
<footer class="r-foot"><div class="r-foot-in">Powered by Kestrel &middot; Unsubscribe anytime &middot; Consent is double opt-in.</div></footer>
</body>
</html>`;
  return new Response(doc, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

function issueRow(i: ArchiveIndexIssue): string {
  return (
    `<li class="r-item"><span class="r-d">${escapeHtml(i.dateLabel)}</span>` +
    `<a class="r-t" href="${escapeHtmlAttr(i.url)}">${escapeHtml(i.title)}</a></li>`
  );
}

/** The public front door (§5): a landing page that features the latest issue, lists
 *  a few recent ones, and links into the full archive — never into the admin. */
export function landingPage(opts: {
  identity: ReaderIdentity;
  subscribeUrl: string;
  homeUrl: string;
  archiveUrl: string;
  /** The most recent issue, featured; absent when nothing has been sent. */
  featured?: ArchiveIndexIssue;
  /** The next-most-recent issues, listed beneath the feature. */
  recent: ArchiveIndexIssue[];
}): Response {
  let main: string;
  if (!opts.featured) {
    main = `<p class="r-empty">No issues yet — subscribe to get the first one.</p>`;
  } else {
    const f = opts.featured;
    const feature =
      `<p class="r-ey">Latest issue</p>` +
      `<article class="r-feat"><p class="r-k">${escapeHtml(f.dateLabel)}</p>` +
      `<h2><a href="${escapeHtmlAttr(f.url)}">${escapeHtml(f.title)}</a></h2>` +
      `<a class="r-link" href="${escapeHtmlAttr(f.url)}">Read here &rarr;</a></article>`;
    const list = opts.recent.length
      ? `<ul class="r-list">${opts.recent.map(issueRow).join("")}</ul>`
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
  });
}

/** The full public archive: every sent issue, newest first (§5). Reached from the
 *  landing page's "Browse the full archive" link; served at the archive base path. */
export function archiveIndexPage(opts: {
  identity: ReaderIdentity;
  subscribeUrl: string;
  homeUrl: string;
  issues: ArchiveIndexIssue[];
}): Response {
  const list = opts.issues.length
    ? `<ul class="r-list">${opts.issues.map(issueRow).join("")}</ul>`
    : `<p class="r-empty">No issues yet.</p>`;
  return readerPage({
    identity: opts.identity,
    subscribeUrl: opts.subscribeUrl,
    homeUrl: opts.homeUrl,
    title: `Archive · ${opts.identity.name}`,
    mainHtml: `<p class="r-ey">Archive</p>${list}`,
  });
}

// The operator setup guide and the API reference are both rendered natively by
// the admin SPA from JSON the authed `/api/docs` and `/api/reference` routes return
// (see src/docs/, src/reference/, and public/dashboard/app.js) — long-form prose is
// styled by the SPA's own `.doc` block, so there is no server-rendered docs page.
