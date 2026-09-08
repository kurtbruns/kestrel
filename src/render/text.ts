/** Derive a readable plain-text alternative from the content HTML. */

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function htmlToText(html: string): string {
  let t = html;
  // Links → "text (href)"
  t = t.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `${stripTags(inner).trim()} (${href})`,
  );
  // Images → "[alt]"
  t = t.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, "[$1]");
  t = t.replace(/<img\b[^>]*>/gi, "");
  // Block boundaries → blank lines; list items → bullets; <br> → newline
  t = t.replace(/<li\b[^>]*>/gi, "\n- ");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre)>/gi, "\n\n");
  t = stripTags(t);
  t = decodeEntities(t);
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
