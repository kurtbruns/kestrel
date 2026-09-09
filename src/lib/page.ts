/** Minimal, themed HTML page for reader-facing routes (confirm, unsubscribe,
 *  subscribe). Automatic light/dark via prefers-color-scheme. */
import { escapeHtml } from "./html";

const STYLE = `
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
.wrap { max-width:480px; margin:64px auto; padding:32px; background:var(--card);
        border:1px solid var(--line); border-radius:10px; line-height:1.6; }
h1 { margin-top:0; }
a { color: inherit; }
.muted { color: var(--muted); }
input { font:inherit; font-size:16px; padding:10px; width:100%; border:1px solid var(--line);
        border-radius:6px; background:var(--card); color:var(--fg); }
.btn { font:inherit; font-size:16px; margin-top:12px; padding:10px 18px; border-radius:6px;
       border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); cursor:pointer; }
.btn-danger { border-color:var(--danger); background:var(--danger); color:var(--danger-fg); }
`;

export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
  return new Response(doc, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
