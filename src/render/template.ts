/** The email shell. A filled, CSS-inlined template — which carries its own footer,
 *  unsubscribe link included — is dropped into one responsive column; this file adds
 *  only the document, the hidden preheader, and the inert archive anchors. The body
 *  holds an anchor comment the archive route swaps for a browser-only masthead
 *  (`archiveMasthead`) — invisible in every email, present only on the hosted page
 *  (I3). Styling lives in the template (inlined at render); the shell carries none. */
import { escapeHtml, escapeHtmlAttr } from "../lib/html";

// The per-recipient delivery sentinels (UNSUB_SENTINEL / SENTTO_SENTINEL) live with the
// token engine that freezes and fills them — see render/template_engine.ts.

/** Inert marker at the top of the content column. Emails render it as nothing
 *  (an HTML comment); the archive route replaces it with `archiveMasthead`, so
 *  the masthead is browser-only and the sent bytes stay masthead-free (I3, I5). */
export const ARCHIVE_MASTHEAD_ANCHOR = "<!--kestrel:masthead-->";

/** Inert marker in the <head>. Emails render it as nothing; the archive route
 *  replaces it with the web-font stylesheet links (see lib/page.ts), so the
 *  display serif loads only on the hosted page — never in a sent email (I3). */
export const ARCHIVE_HEAD_ANCHOR = "<!--kestrel:head-->";

/** Display serif for content headings — the publication's editorial voice, shared
 *  with the reader chrome's `--r-serif` (lib/page.ts); keep the two in step. Baked
 *  into the frozen render so the archive page and the email agree (I3). Fraunces is
 *  a web font loaded only on the hosted page; email and any client without it fall
 *  back to Georgia, an ubiquitous serif. */
const HEADING_FONT = "Fraunces, Georgia, 'Times New Roman', serif";

export interface LayoutInput {
  subject: string;
  preheader: string;
  /** The filled + CSS-inlined email template — the whole visible body, footer included. */
  bodyHtml: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function emailLayout(i: LayoutInput): string {
  const preheader = i.preheader
    ? `<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(
        i.preheader,
      )}</span>`
    : "";
  // The shell advertises light+dark and darkens only its own frame (the outer
  // background) in dark mode; the template owns the content's dark colors via its own
  // `@media` block. Both @media blocks survive CSS inlining (only non-at-rules inline)
  // and are consolidated into <head>; their dark overrides use !important to beat the
  // inlined light styles — the standard email dark-mode technique. The body cell sets
  // a base font/color as a fallback for content the template doesn't wrap.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(i.subject)}</title>${ARCHIVE_HEAD_ANCHOR}
<style>@media (prefers-color-scheme: dark) { .k-bg { background: #18181b !important; } }</style>
</head>
<body class="k-bg" style="margin:0;padding:0;background:#ffffff;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="k-bg" style="background:#ffffff;"><tr><td align="center" style="padding:8px 12px 48px;">
<table role="presentation" width="664" cellpadding="0" cellspacing="0" class="k-bg" style="max-width:664px;width:100%;background:#ffffff;">
<tr><td style="padding:24px 32px 32px;font-family:${FONT};font-size:16px;line-height:1.6;color:#18181b;word-break:break-word;">
${ARCHIVE_MASTHEAD_ANCHOR}${i.bodyHtml}
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
export function archiveMasthead(opts: {
  name: string;
  dateLabel: string;
  indexUrl: string;
}): string {
  const name = escapeHtml(opts.name);
  const date = escapeHtml(opts.dateLabel);
  const url = escapeHtmlAttr(opts.indexUrl);
  return (
    `<div class="k-mast" style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;` +
    `font-family:${FONT};font-size:13px;line-height:1.5;color:#71717a;` +
    `padding-bottom:14px;margin-bottom:28px;border-bottom:1px solid #e4e4e7;">` +
    `<a href="${url}" style="color:inherit;text-decoration:none;font-weight:600;font-size:15px;font-family:${HEADING_FONT};"><span style="font-family:${FONT};font-weight:500;">&larr;</span>&nbsp;${name}</a>` +
    `<span style="white-space:nowrap;">${date}</span>` +
    `</div>`
  );
}
