/** Minimal, inline-styled HTML page for reader-facing routes (confirm, unsubscribe, subscribe). */
import { escapeHtml } from "./html";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title></head>
<body style="margin:0;font-family:${FONT};background:#f4f4f5;color:#18181b;">
<div style="max-width:480px;margin:64px auto;padding:32px;background:#ffffff;border-radius:10px;line-height:1.6;">
${bodyHtml}
</div>
</body></html>`;
  return new Response(doc, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
