// The inline Markdown the API reference writes its prose in (`code`, **bold**, [links](url),
// and blank-line paragraphs), as markup. Built through `html`, so every piece of text is
// escaped as text and no HTML in the source ever becomes an element: the only elements are
// the ones made here. A link keeps its `href` only for a web address or a path on this
// origin; any other target (a `javascript:` URL, a bare anchor the editor's router would
// misread) renders its text alone.

import { type Html, html } from "./html";

/** One run of inline Markdown: a code span, bold text, or a link, in source order. */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Whether a link's target is one to follow: a web address, or a path on this origin. */
function safeHref(href: string): boolean {
  // A second `/`, or a `\` a browser reads as one, would make it another host's address.
  return /^https:\/\//i.test(href) || /^\/(?![/\\])/.test(href);
}

/** A line of inline Markdown as markup. */
export function inline(text: string): Html {
  const parts: (Html | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    parts.push(text.slice(last, at));
    const [, code, bold, label, href] = m;
    if (code !== undefined) {
      parts.push(html`<code>${code}</code>`);
    } else if (bold !== undefined) {
      parts.push(html`<strong>${inline(bold)}</strong>`);
    } else if (label !== undefined && href !== undefined) {
      parts.push(safeHref(href) ? html`<a href="${href}">${inline(label)}</a>` : inline(label));
    }
    last = at + m[0].length;
  }
  parts.push(text.slice(last));
  return html`${parts}`;
}

/** Paragraphs of inline Markdown, split at blank lines, each a `<p>` with `cls`. */
export function prose(text: string, cls: string): Html {
  return html`${text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => html`<p class="${cls}">${inline(p.trim())}</p>`)}`;
}
