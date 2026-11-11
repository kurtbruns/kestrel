/** The email shell. A filled, CSS-inlined template — which carries its own footer,
 *  unsubscribe link included — is dropped into one responsive column; this file adds
 *  only the document, the hidden preheader, and the inert archive anchors. The body
 *  holds an anchor comment the archive route swaps for a browser-only masthead
 *  (`archiveMasthead`) — invisible in every email, present only on the hosted page
 *  (I3). Styling lives in the template (inlined at render); the shell carries only its
 *  frame's: the column's padding and background. */
import { inlineStack, SANS_STACK, SERIF_STACK } from "../../shared/fonts";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";

// The per-recipient delivery sentinels (UNSUB_SENTINEL / SENTTO_SENTINEL) live with the
// token engine that freezes and fills them — see render/template_engine.ts.

/** Inert marker at the top of the content column. Emails render it as nothing
 *  (an HTML comment); the archive route replaces it with `archiveMasthead`, so
 *  the masthead is browser-only and the sent bytes stay masthead-free (I3, I5). */
export const ARCHIVE_MASTHEAD_ANCHOR = "<!--kestrel:masthead-->";

/** Inert marker in the <head>. Emails render it as nothing; the archive route
 *  replaces it with the hosted page's own styles (`ARCHIVE_POST_HEAD` in lib/page.ts),
 *  so they reach only the hosted page, never a sent email (I3). */
export const ARCHIVE_HEAD_ANCHOR = "<!--kestrel:head-->";

/** Inert markers around an email-only region, which the template marks with
 *  `{{ if .IsEmail }} … {{ end }}`. The frozen render keeps the region's content between
 *  them, so the sent email carries it (mail clients ignore the comments); the archive
 *  route removes each marked span with `omitEmailOnly`, so the public page leaves out
 *  inbox furniture (an unsubscribe link, the mailing address) and nothing else (I3). */
export const EMAIL_ONLY_OPEN = "<!--kestrel:email-->";
export const EMAIL_ONLY_CLOSE = "<!--/kestrel:email-->";

/** The frozen render as the public page shows it: every email-only region removed,
 *  markers included. A render without markers (a template with no region, or a send
 *  frozen before regions existed) comes back unchanged. */
export function omitEmailOnly(html: string): string {
  return html.replace(EMAIL_ONLY_REGION, "");
}

const EMAIL_ONLY_REGION = /<!--kestrel:email-->([\s\S]*?)<!--\/kestrel:email-->/g;

/** Elements with no closing tag, which a region may hold without closing. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * Whether every email-only region in a parsed (CSS-inlined) render is whole elements,
 * so `omitEmailOnly` leaves well-formed markup and removes nothing outside the region.
 * Validation checks the template's text, but the HTML parser can still rearrange it: a
 * region tag inside an attribute, a region opened in one element and closed in another,
 * or content a table pushes out ahead of itself (foster-parenting), which can carry the
 * post into a region. A region passes when its tags balance and no tag is cut in half:
 * the serializer escapes `<` and `>` in text, so a bare one left after removing whole
 * tags means a marker sat inside a tag.
 */
export function emailOnlyRegionsWhole(html: string): boolean {
  for (const m of html.matchAll(EMAIL_ONLY_REGION)) {
    const span = (m[1] ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    const open: string[] = [];
    for (const t of span.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^<>]*>/g)) {
      const name = (t[2] ?? "").toLowerCase();
      if (t[1]) {
        if (open.pop() !== name) {
          return false;
        }
      } else if (!VOID_ELEMENTS.has(name) && !t[0].endsWith("/>")) {
        open.push(name);
      }
    }
    if (open.length > 0 || /[<>]/.test(span.replace(/<\/?[a-zA-Z][\w-]*\b[^<>]*>/g, ""))) {
      return false;
    }
  }
  return true;
}

/** The serif for the masthead's publication name: the one the reader pages and the
 *  built-in template name (shared/fonts.ts), so the masthead, the frozen post beneath
 *  it, and the pages around it read as one publication. */
const HEADING_FONT = SERIF_STACK;

export interface LayoutInput {
  subject: string;
  preheader: string;
  /** The filled + CSS-inlined email template — the whole visible body, footer included. */
  bodyHtml: string;
}

/** The shell's base font, spelled as every email already sent spells it (I3). */
const FONT = inlineStack(SANS_STACK);

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
  //
  // The side padding is 44px inline (12px outer, 32px inner), which every client shows,
  // so a client that drops <style> keeps the wide look rather than losing its margins. The
  // narrow rule brings the inner cell to 12px, 24px a side in all, where the reader pages'
  // own text sits, and at the width where they reflow (lib/page.ts), past any phone held
  // upright. Lower inline values would reach every client, but move every wide display too.
  // The Template page's sample email copies these figures (client/settings/template.ts).
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(i.subject)}</title>${ARCHIVE_HEAD_ANCHOR}
<style>@media (prefers-color-scheme: dark) { .k-bg { background: #18181b !important; } }
@media (max-width:560px) { .k-pad { padding-left:12px !important; padding-right:12px !important; } }</style>
</head>
<body class="k-bg" style="margin:0;padding:0;background:#ffffff;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="k-bg" style="background:#ffffff;"><tr><td align="center" style="padding:8px 12px 48px;">
<table role="presentation" width="664" cellpadding="0" cellspacing="0" class="k-bg" style="max-width:664px;width:100%;background:#ffffff;">
<tr><td class="k-pad" style="padding:24px 32px 32px;font-family:${FONT};font-size:16px;line-height:1.6;color:#18181b;word-break:break-word;">
${ARCHIVE_MASTHEAD_ANCHOR}${i.bodyHtml}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** Browser-only masthead for the hosted archive page: the publication name
 *  (linked back to the post index) and the publish date, sitting above the
 *  frozen content. Never appears in an email — the archive route injects it in
 *  place of `ARCHIVE_MASTHEAD_ANCHOR`. Because it's browser-only (not email
 *  content), its colors are a plain stylesheet rule keyed off `.k-mast`, themed
 *  light/dark in `ARCHIVE_POST_HEAD` (lib/page.ts) — no inline color, so no
 *  `!important` to retheme it. Only layout/type stays inline here, where the font
 *  constants live and nothing needs a media query. */
export function archiveMasthead(opts: {
  name: string;
  dateLabel: string;
  indexUrl: string;
}): string {
  // The link back to the index is the publication's name, or, with none, what it leads
  // to, so the arrow never points at nothing.
  const name = escapeHtml(opts.name || "Archive");
  const date = escapeHtml(opts.dateLabel);
  const url = escapeHtmlAttr(opts.indexUrl);
  return (
    `<div class="k-mast" style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;` +
    `font-family:${FONT};font-size:13px;line-height:1.5;padding-bottom:14px;margin-bottom:28px;">` +
    `<a href="${url}" style="text-decoration:none;font-weight:600;font-size:15px;font-family:${HEADING_FONT};"><span style="font-family:${FONT};font-weight:500;">&larr;</span>&nbsp;${name}</a>` +
    `<span style="white-space:nowrap;">${date}</span>` +
    `</div>`
  );
}
