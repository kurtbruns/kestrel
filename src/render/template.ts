/** The single email layout. Content is wrapped once; the footer carries the
 *  per-recipient unsubscribe sentinel and the view-in-browser link. The body
 *  also holds an inert anchor comment the archive route swaps for a browser-only
 *  masthead (`archiveMasthead`) — invisible in every email, present only on the
 *  hosted page (I3). */
import { escapeHtml, escapeHtmlAttr } from "../lib/html";

/** Literal placeholder for the per-recipient unsubscribe URL, substituted at
 *  delivery (real send / test) or with a generic link (preview / archive).
 *  A plain sentinel (not `{{ }}`) so it survives SES template semantics. */
export const UNSUB_SENTINEL = "%%UNSUBSCRIBE_URL%%";

/** Inert marker at the top of the content column. Emails render it as nothing
 *  (an HTML comment); the archive route replaces it with `archiveMasthead`, so
 *  the masthead is browser-only and the sent bytes stay masthead-free (I3, I5). */
export const ARCHIVE_MASTHEAD_ANCHOR = "<!--kestrel:masthead-->";

export interface LayoutInput {
  subject: string;
  preheader: string;
  contentHtml: string;
  viewInBrowserUrl: string;
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function emailLayout(i: LayoutInput): string {
  const preheader = i.preheader
    ? `<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(
        i.preheader,
      )}</span>`
    : "";
  const viewUrl = escapeHtmlAttr(i.viewInBrowserUrl);
  // Inline styles are the light default; the <style> block layers dark-mode
  // overrides (with !important, since inline styles win otherwise). Clients that
  // honor prefers-color-scheme (Apple Mail, iOS, and the web archive/preview)
  // render dark; everything else falls back to the light inline styles.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(i.subject)}</title>
<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    .k-bg { background:#18181b !important; }
    .k-card { background:#18181b !important; }
    .k-body { color:#ededed !important; }
    .k-body a { color:#93c5fd !important; }
    .k-foot { color:#a1a1aa !important; border-color:#2e2e33 !important; }
    .k-foot a { color:#a1a1aa !important; }
    .k-mast { color:#a1a1aa !important; border-color:#2e2e33 !important; }
    .k-mast a { color:#a1a1aa !important; }
  }
</style></head>
<body class="k-bg" style="margin:0;padding:0;background:#ffffff;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="k-bg" style="background:#ffffff;"><tr><td align="center" style="padding:8px 12px 48px;">
<table role="presentation" width="664" cellpadding="0" cellspacing="0" class="k-card" style="max-width:664px;width:100%;background:#ffffff;">
<tr><td class="k-body" style="padding:24px 32px 32px;font-family:${FONT};font-size:16px;line-height:1.6;color:#18181b;word-break:break-word;">
${ARCHIVE_MASTHEAD_ANCHOR}${i.contentHtml}
</td></tr>
<tr><td class="k-foot" style="padding:16px 32px 28px;font-family:${FONT};font-size:12px;line-height:1.5;color:#71717a;border-top:1px solid #e4e4e7;">
<a href="${viewUrl}" style="color:#71717a;text-decoration:underline;">View in browser</a> &middot; <a href="${UNSUB_SENTINEL}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** Browser-only masthead for the hosted archive page: the publication name
 *  (linked back to the issue index) and the publish date, sitting above the
 *  frozen content. Never appears in an email — the archive route injects it in
 *  place of `ARCHIVE_MASTHEAD_ANCHOR`. Rendered only in a browser, so it can use
 *  ordinary CSS; `.k-mast` carries the dark-mode override. */
export function archiveMasthead(opts: { name: string; dateLabel: string; indexUrl: string }): string {
  const name = escapeHtml(opts.name);
  const date = escapeHtml(opts.dateLabel);
  const url = escapeHtmlAttr(opts.indexUrl);
  return (
    `<div class="k-mast" style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;` +
    `font-family:${FONT};font-size:13px;line-height:1.5;color:#71717a;` +
    `padding-bottom:14px;margin-bottom:28px;border-bottom:1px solid #e4e4e7;">` +
    `<a href="${url}" style="color:inherit;text-decoration:none;font-weight:600;">${name}</a>` +
    `<span style="white-space:nowrap;">${date}</span>` +
    `</div>`
  );
}
