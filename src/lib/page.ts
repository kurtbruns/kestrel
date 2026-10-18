/** HTML for the reader-facing routes: the branded reader shell (`readerPage`) behind
 *  the home page, the archive index, the subscribe flow, and the message pages a
 *  reader lands on from an email (confirm, unsubscribe, not found), via `messagePage`.
 *  Automatic light/dark via prefers-color-scheme. */
import { escapeHtml, escapeHtmlAttr } from "./html";
import { PAGE_SECURITY_HEADERS } from "./page_headers";

/* The reader surface (§5): the public home page at `/`, the full archive index at
   the archive base path, the subscribe pages, and the message pages. All wear the
   publication's identity — a light masthead over an editorial serif — deliberately
   not the neutral zinc admin chrome, and link only to public pages, never into the
   Access-gated admin surface (§11). The listing pages are indexable; the message
   pages are not (see `messagePage`). */

/** The reader ground — shared by the chrome pages here and injected onto the hosted
 *  post page (see `ARCHIVE_POST_HEAD`), so the whole publication sits on one
 *  background in each theme. The sent email keeps its own white; this is web-only. */
const READER_BG_LIGHT = "#fbfbfa";
const READER_BG_DARK = "#12110f";

/* The app's brand accent (DESIGN.md §8), mirrored here for the publisher-only chrome the
   reader surface carries: the dev pill and the test pages' strip. Only the publisher ever
   sees them, and they are the app speaking, not the publication, so they wear the app's
   action color, matching a Primary action, rather than the reader ink; keep these values in
   sync with styles.css. This is the one deliberate exception to "the reader surface is not
   styled from the admin tokens" (DESIGN.md, reader-surface note). Each stylesheet below
   carries them, so either works alone on a page. */
const APP_ACCENT_TOKENS = `
:root { --k-accent:#3355cc; --k-accent-contrast:#ffffff; }
@media (prefers-color-scheme: dark) { :root { --k-accent:#7d9bff; --k-accent-contrast:#10131f; } }
`;

/* Dev-only affordance (SPEC §5/§11): a fixed corner pill that hops a local
   developer into the editor. Shown solely on a dev-shaped instance and rendered as
   over-the-page dev chrome — deliberately not the publication's own identity — so
   it reads as tooling, never as part of the reader surface. Absent once deployed.
   Self-contained, because it rides two kinds of page: the reader shell and a post
   page (as browser-only chrome injected into the frozen render). The post page has
   none of the reader tokens, so the font is set here rather than inherited. */
const DEV_BADGE_STYLE = `${APP_ACCENT_TOKENS}
.r-dev { position:fixed; right:18px; bottom:18px; z-index:50; display:inline-flex; align-items:center; gap:8px;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height:1.6;
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
.r-dev:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media (prefers-color-scheme: dark) { .r-dev:focus-visible { outline-color:#60a5fa; } }
`;

/* The test strip: a full-width strip across the top of a page that only shows what a
   reader would see (a test email's or a preview's unsubscribe link), above and outside the
   publication's masthead, so the masthead beneath is exactly the one a reader gets. Only
   the publisher sees it, so it wears the dev pill's look: the full accent fill with
   contrast text (about 6.3:1 light and 7:1 dark), and its tag as the pill's inverted chip.
   Its content sits in the reader measure, so the sentence starts on the masthead's left
   edge while the ground runs edge to edge. The editor's web version wears the same strip
   in admin CSS (`.web-bar` in styles.css); keep the two in sync. */
const READER_BANNER_STYLE = `${APP_ACCENT_TOKENS}
.r-banner { background:var(--k-accent); color:var(--k-accent-contrast);
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
            font-size:13.5px; font-weight:500; line-height:1.4; }
/* The tag runs in, inline with the sentence, so on a phone the sentence wraps beneath it at
   the strip's full width rather than in a narrow column beside it. */
.r-banner-in { max-width:var(--r-measure); margin:0 auto; padding:10px 24px; }
.r-banner-tag { display:inline-block; margin-right:10px; font-size:10px; letter-spacing:.09em;
                text-transform:uppercase; font-weight:700; padding:1px 7px; border-radius:999px;
                background:var(--k-accent-contrast); color:var(--k-accent); }
.r-banner-text { overflow-wrap:anywhere; }
`;

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
}
@media (prefers-color-scheme: dark) {
  :root { --r-bg:${READER_BG_DARK}; --r-ink:#ece9e3; --r-card:#1b1a17; --r-line:#2c2a25; --r-mut:#a5a199; }
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
/* A lede already ends in its own margin, so a link straight beneath it sits closer. */
.r-lead + .r-arch { margin-top:0; }

/* Subscribe / message pages: a headline, lede, and a branded form. */
.r-h1 { font-family:var(--r-serif); font-size:30px; line-height:1.12; font-weight:600; letter-spacing:-.01em; margin:0 0 12px; }
.r-lead { font-size:16px; color:var(--r-mut); margin:0 0 22px; max-width:54ch; }
.r-lead strong { color:var(--r-ink); font-weight:600; }
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

a:focus-visible, .r-sub:focus-visible, .r-btn:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media (prefers-color-scheme: dark) {
  a:focus-visible, .r-sub:focus-visible, .r-btn:focus-visible { outline-color:#60a5fa; }
}
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
 *  no `!important` needed. The publication name takes the email's body ink, so it reads
 *  as the page's title rather than a caption; the date stays muted, at `#52525b` in light
 *  (~7:1 on the reader ground; `#71717a` was ~3.9:1) and `#a1a1aa` in dark (~7:1). */
export const ARCHIVE_POST_HEAD =
  FRAUNCES_FONT_LINKS +
  `<style>body.k-bg,body .k-bg,body .k-card{background:${READER_BG_LIGHT}!important}` +
  `.k-mast{color:#52525b;border-bottom:1px solid #e4e4e7}.k-mast a{color:#18181b}` +
  `@media(prefers-color-scheme:dark){body.k-bg,body .k-bg,body .k-card{background:${READER_BG_DARK}!important}` +
  `.k-mast{color:#a1a1aa;border-bottom-color:#2e2e33}.k-mast a{color:#ededed}}</style>`;

/** One post as the reader surface lists it: its title, its archive URL, and a display date. */
export interface ArchiveIndexPost {
  title: string;
  url: string;
  dateLabel: string;
}

/** A strip above the masthead naming what kind of page this is, for a page that only
 *  shows what a reader would see: a short tag ("Test") and a sentence. */
export interface ReaderBanner {
  tag: string;
  text: string;
}

/** The publication identity the reader chrome renders. */
export interface ReaderIdentity {
  name: string;
  tagline?: string;
  logoUrl?: string;
}

/** The tab icon for a reader page: the publication's logo, already a square (the upload
 *  crops it), at its own upload's address, so a new logo is a new URL. Absent with no
 *  logo, leaving the browser's default; the reader surface wears the publication's
 *  identity, never the app's mark. Browser-only chrome: a post page gets it through the
 *  head anchor at serve time, never in the frozen render or an email (I3). */
export function readerIconLink(logoUrl?: string): string {
  return logoUrl ? `<link rel="icon" href="${escapeHtmlAttr(logoUrl)}">` : "";
}

/** The pill's stylesheet, emitted beside it and only when it is, so a deployed page
 *  carries neither the link nor its styles. */
function devDashboardStyle(url?: string): string {
  return url ? `<style>${DEV_BADGE_STYLE}</style>` : "";
}

/** The dev-only editor shortcut (SPEC §5/§11): a fixed corner pill linking a local
 *  developer straight into `/dashboard`. Rendered only when `url` is set — the
 *  callers pass it solely on a dev-shaped instance (`config.devMode`), where
 *  `/dashboard` carries no Access wall — so it is structurally absent once deployed
 *  and never turns a public page into a link toward the admin gate. */
function devDashboardBadge(url?: string): string {
  // The "DEV" chip flags it as tooling; the title spells out the scope for anyone
  // who wonders whether it ships — it never does (see the doc above).
  return url
    ? `<a class="r-dev" href="${escapeHtmlAttr(url)}" title="Shown only on your local dev server"><span class="r-dev-tag">Dev</span>Open dashboard &rarr;</a>`
    : "";
}

/** The dev-only shortcut's browser-only chrome for a hosted post page, which is not
 *  a reader shell: its stylesheet for the head anchor and the pill for the masthead
 *  anchor. The archive route fills them into the served page only, so neither reaches
 *  the frozen render or a sent email (I3). Both empty when `url` is unset, as it is on
 *  every deployed instance. */
export function archiveDevDashboardChrome(url?: string): { head: string; masthead: string } {
  return { head: devDashboardStyle(url), masthead: devDashboardBadge(url) };
}

/** The strip's stylesheet, emitted beside it and only when it is. */
function readerBannerStyle(banner?: ReaderBanner): string {
  return banner ? `<style>${READER_BANNER_STYLE}</style>` : "";
}

/** The shared reader shell: a brand masthead (identity, plus a "Subscribe here →"
 *  call to action when `subscribeUrl` is given) and a footer, wrapping page-specific
 *  `mainHtml`. Public and indexable unless `private`; every link points only at public
 *  pages (§11). */
export function readerPage(opts: {
  identity: ReaderIdentity;
  /** Where the brand links. Null for a page with no way home, whose masthead is left out
   *  when the brand and the call to action are both empty. */
  homeUrl: string | null;
  title: string;
  mainHtml: string;
  /** When set, the masthead shows the subscribe CTA linking here. Omitted on the
   *  subscribe pages themselves, where the CTA would point at the current page. */
  subscribeUrl?: string;
  /** Dev-only: the `/dashboard` URL for the local-developer shortcut. Passed solely
   *  on a dev-shaped instance (§11); omitted — and so hidden — in any deployed env. */
  devDashboardUrl?: string;
  /** A strip above the masthead, for a page shown as a test of what a reader sees. */
  banner?: ReaderBanner;
  /** HTTP status; defaults to 200 (a rejected subscribe form uses 400). */
  status?: number;
  /** For a page that can show one reader's address: never stored by a cache and kept
   *  out of search engines. Otherwise the page is briefly cacheable and indexable. */
  private?: boolean;
}): Response {
  const { name, tagline, logoUrl } = opts.identity;
  const logo = logoUrl
    ? `<span class="r-logo"><img src="${escapeHtmlAttr(logoUrl)}" alt=""></span>`
    : "";
  const nameHtml = name ? `<span class="r-name">${escapeHtml(name)}</span>` : "";
  const tag = tagline ? `<div class="r-tag">${escapeHtml(tagline)}</div>` : "";
  const text = nameHtml || tag ? `<span>${nameHtml}${tag}</span>` : "";
  // The brand shows only what the publication has, never a made-up name: a logo alone
  // still needs a link name, and with nothing at all the way home reads "Archive".
  const label = text ? "" : logo ? ' aria-label="Home"' : "";
  const brand =
    opts.homeUrl === null
      ? logo || text
        ? `<span class="r-brand">${logo}${text}</span>`
        : ""
      : `<a class="r-brand" href="${escapeHtmlAttr(opts.homeUrl)}"${label}>${logo || text ? `${logo}${text}` : "Archive"}</a>`;
  const cta = opts.subscribeUrl
    ? `<span class="r-cta"><a class="r-sub" href="${escapeHtmlAttr(opts.subscribeUrl)}">Subscribe here &rarr;</a></span>`
    : "";
  const masthead =
    brand || cta
      ? `<header class="r-mast"><div class="r-mast-in">\n${brand}\n${cta}\n</div></header>\n`
      : "";
  const banner = opts.banner
    ? `<div class="r-banner" role="note"><div class="r-banner-in"><span class="r-banner-tag">${escapeHtml(opts.banner.tag)}</span><span class="r-banner-text">${escapeHtml(opts.banner.text)}</span></div></div>`
    : "";
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${readerIconLink(logoUrl)}${FRAUNCES_FONT_LINKS}
<style>${READER_STYLE}</style>${readerBannerStyle(opts.banner)}${devDashboardStyle(opts.devDashboardUrl)}
</head>
<body>
${banner}${masthead}<main class="r-body">${opts.mainHtml}</main>
<footer class="r-foot"><div class="r-foot-in">Powered by Kestrel</div></footer>
${devDashboardBadge(opts.devDashboardUrl)}
</body>
</html>`;
  return new Response(doc, {
    status: opts.status ?? 200,
    headers: {
      ...PAGE_SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      ...(opts.private
        ? { "cache-control": "no-store", "x-robots-tag": "noindex" }
        : { "cache-control": "public, max-age=300" }),
    },
  });
}

/** A reader page's tab title: the page's own name, then the publication's when it has
 *  one, so a publication with no name gets "Archive", not "Archive · ". */
export function pageTitle(page: string, name: string): string {
  return name ? `${page} · ${name}` : page;
}

/** What a message page takes: the shell's identity and links, plus its own copy.
 *  `ledeHtml` and `afterHtml` are markup, so the caller escapes what it interpolates. */
export interface MessagePageOptions {
  identity: ReaderIdentity;
  homeUrl: string | null;
  /** The page's own name; the publication name is appended for the tab title. */
  title: string;
  eyebrow: string;
  headline: string;
  ledeHtml: string;
  afterHtml?: string;
  status?: number;
  devDashboardUrl?: string;
  banner?: ReaderBanner;
}

/** A message page in the reader shell (confirm, unsubscribe, not found): an eyebrow,
 *  a serif headline, a muted lede, and an optional form or link beneath. A reader
 *  arrives here from an email, so the page carries their newsletter's identity but no
 *  subscribe call to action, which would pull them off the task they came for. Always
 *  `private`: several show the reader's address, and none is worth indexing. */
export function messagePage(opts: MessagePageOptions): Response {
  return readerPage({
    identity: opts.identity,
    homeUrl: opts.homeUrl,
    title: pageTitle(opts.title, opts.identity.name),
    mainHtml:
      `<p class="r-ey">${escapeHtml(opts.eyebrow)}</p>` +
      `<h1 class="r-h1">${escapeHtml(opts.headline)}</h1>` +
      `<p class="r-lead">${opts.ledeHtml}</p>` +
      (opts.afterHtml ?? ""),
    status: opts.status,
    devDashboardUrl: opts.devDashboardUrl,
    banner: opts.banner,
    private: true,
  });
}

/**
 * What a reader gets while the deployment's configuration is refused (SPEC §9): a plain 503
 * that says the page is unavailable for now. It names no setting and reads nothing, not even
 * the publication's identity, since the app is not running; the setting to fix is the admin
 * surface's to say. Never cached, so the real page returns as soon as the configuration is
 * fixed.
 */
export function unavailablePage(): Response {
  const res = messagePage({
    identity: { name: "" },
    // No way home: `/` is this same page until the configuration is fixed.
    homeUrl: null,
    title: "Temporarily unavailable",
    eyebrow: "Unavailable",
    headline: "This page is temporarily unavailable",
    ledeHtml: "The newsletter can't be reached right now. Please try again a little later.",
    status: 503,
  });
  // A client that honors it waits five minutes rather than retrying a page that can't
  // change until the operator acts.
  res.headers.set("retry-after", "300");
  return res;
}

/**
 * What a reader gets when a reader route fails on something nothing handled (SPEC §12): a
 * plain 500 page saying something went wrong, never the API's JSON error body. Like
 * `unavailablePage` it reads nothing, not even the publication's identity, since the failure
 * may be the database itself, and it is never cached.
 */
export function serverErrorPage(): Response {
  return messagePage({
    identity: { name: "" },
    homeUrl: null,
    title: "Something went wrong",
    eyebrow: "Error",
    headline: "Something went wrong",
    ledeHtml: "This page couldn't be shown just now. Please try again a little later.",
    status: 500,
  });
}

/** A reader page's closing link into the archive, never an admin path (§11). */
export function archiveLink(url: string, label: string): string {
  return `<a class="r-arch" href="${escapeHtmlAttr(url)}">${escapeHtml(label)} &rarr;</a>`;
}

function postRow(i: ArchiveIndexPost): string {
  return (
    `<li class="r-item"><span class="r-d">${escapeHtml(i.dateLabel)}</span>` +
    `<a class="r-t" href="${escapeHtmlAttr(i.url)}">${escapeHtml(i.title)}</a></li>`
  );
}

/** The public front door (§5): a home page that features the latest post, lists
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
    main = feature + list + archiveLink(opts.archiveUrl, "Browse the full archive");
  }
  return readerPage({
    identity: opts.identity,
    subscribeUrl: opts.subscribeUrl,
    homeUrl: opts.homeUrl,
    // The front door is titled by the publication; with no name, by what it is.
    title: opts.identity.name || "Home",
    mainHtml: main,
    devDashboardUrl: opts.devDashboardUrl,
  });
}

/** The full public archive: every published post, newest first (§5). Reached from the
 *  home page's "Browse the full archive" link; served at the archive base path. */
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
    title: pageTitle("Archive", opts.identity.name),
    mainHtml: `<p class="r-ey">Archive</p>${list}`,
    devDashboardUrl: opts.devDashboardUrl,
  });
}

// The setup guide and the API reference are both rendered natively by
// the admin SPA from JSON the authed `/api/docs` and `/api/reference` routes return
// (see src/docs/, src/reference/, and client/main.ts) — long-form prose is
// styled by the SPA's own `.doc` block, so there is no server-rendered docs page.
