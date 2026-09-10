/** Minimal, themed HTML pages for reader-facing routes (confirm, unsubscribe,
 *  subscribe, and the public archive index) and the in-app admin docs page.
 *  Automatic light/dark via prefers-color-scheme. */
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

const INDEX_STYLE = `${TOKENS}
/* The front door matches the newsletter surface: plain white (dark #18181b),
   no card — not the muted ground the small form/card pages use. */
body { background:#ffffff; }
@media (prefers-color-scheme: dark) { body { background:#18181b; } }
.wrap { max-width:640px; margin:0 auto; padding:40px 24px 80px; line-height:1.6; }
.masthead { border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:8px; }
.masthead h1 { margin:0 0 4px; font-size:28px; letter-spacing:-0.02em; }
.masthead p { margin:0; }
.masthead a { text-decoration: underline; }
ul.issues { list-style:none; margin:0; padding:0; }
li.issue { display:flex; align-items:baseline; justify-content:space-between; gap:16px;
           padding:16px 0; border-bottom:1px solid var(--line); }
li.issue a { font-size:17px; font-weight:600; text-decoration:none; }
li.issue a:hover { text-decoration: underline; }
li.issue .date { flex:none; font-size:14px; color:var(--muted); white-space:nowrap; }
li.empty { padding:24px 0; }
a:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media (prefers-color-scheme: dark) { a:focus-visible { outline-color:#60a5fa; } }
`;

/** One issue on the archive index: its title, its archive URL, and a display date. */
export interface ArchiveIndexIssue {
  title: string;
  url: string;
  dateLabel: string;
}

/** The public front door (§10): a self-contained index of past issues. Indexable
 *  (no noindex) and links only to public pages — never into the admin surface. */
export function archiveIndexPage(opts: {
  name: string;
  subscribeUrl: string;
  issues: ArchiveIndexIssue[];
}): Response {
  const items = opts.issues.length
    ? opts.issues
        .map(
          (i) =>
            `<li class="issue"><a href="${escapeHtmlAttr(i.url)}">${escapeHtml(i.title)}</a>` +
            `<span class="date">${escapeHtml(i.dateLabel)}</span></li>`,
        )
        .join("")
    : `<li class="empty muted">No issues yet.</li>`;
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.name)}</title>
<style>${INDEX_STYLE}</style>
</head>
<body><div class="wrap">
<header class="masthead">
<h1>${escapeHtml(opts.name)}</h1>
<p class="muted">Past issues. <a href="${escapeHtmlAttr(opts.subscribeUrl)}">Subscribe</a> to get the next one.</p>
</header>
<ul class="issues">${items}</ul>
</div></body>
</html>`;
  return new Response(doc, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

// Prose styling for the in-app docs page. Long-form reading rather than the card
// chrome above: comfortable measure, scrollable code/tables, themed via TOKENS.
const DOC_STYLE = `${TOKENS}
body { line-height:1.65; background:var(--card); }
.doc { max-width:760px; margin:0 auto; padding:32px 24px 64px; }
.doc > :first-child { margin-top:0; }
.doc h1 { font-size:28px; letter-spacing:-0.02em; margin:0 0 8px; }
.doc h2 { font-size:20px; margin:32px 0 8px; padding-top:16px; border-top:1px solid var(--line); }
.doc h3 { font-size:16px; margin:24px 0 8px; }
.doc p, .doc li { font-size:15px; }
.doc a { text-decoration:underline; }
.doc ul, .doc ol { padding-left:22px; }
.doc li { margin:4px 0; }
.doc code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px;
            background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
.doc pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:14px 16px;
           overflow-x:auto; line-height:1.5; }
.doc pre code { background:none; border:0; padding:0; font-size:13px; }
.doc blockquote { margin:16px 0; padding:2px 16px; border-left:3px solid var(--line); color:var(--muted); }
.doc hr { border:0; border-top:1px solid var(--line); margin:32px 0; }
.doc table { border-collapse:collapse; width:100%; margin:16px 0; display:block; overflow-x:auto; }
.doc th, .doc td { border:1px solid var(--line); padding:8px 12px; text-align:left; font-size:14px; vertical-align:top; }
.doc th { background:var(--bg); font-weight:600; }
.doc img { max-width:100%; height:auto; }
`;

/** One admin docs page: sanitized Markdown→HTML wrapped in themed prose chrome.
 *  A Markdown→web-page path, deliberately separate from the single email render
 *  path (I5). Served only through the authed docs API and shown in the editor's
 *  Docs view — never a top-level navigation (which would carry no bearer). */
export function docPage(title: string, contentHtml: string): Response {
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<title>${escapeHtml(title)}</title>
<style>${DOC_STYLE}</style>
</head>
<body><article class="doc">${contentHtml}</article></body>
</html>`;
  return new Response(doc, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

// The API reference is rendered natively by the admin SPA from the JSON the
// `/api/reference` route returns (see src/reference/ + public/dashboard/app.js) —
// there is no server-rendered reference page.
