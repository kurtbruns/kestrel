/**
 * Email-HTML hygiene pass — NOT a hardened XSS sanitizer, and not a security boundary.
 *
 * Authors are trusted (only the operator + Claude, behind auth). The pass removes a few
 * constructs no email body needs and nothing else, so it never changes the author's words.
 * Script URLs (`javascript:`, `vbscript:`) are deliberately left as written: rewriting them
 * anywhere in the HTML changed posts' prose, code, and ordinary links, and narrowing that to
 * attributes takes a real parser and still leaves gaps. What keeps one dead is where it is
 * read: every page Kestrel serves with a post's HTML runs no script (`shared/page_policy.ts`,
 * SPEC §5), and in an inbox the link is the mail client's to handle, as every other link
 * is, never on Kestrel's origin. This is the single seam where a full allowlist
 * sanitizer would drop in if authorship ever widens.
 */
export function sanitizeEmailHtml(html: string): string {
  let out = html;
  // Drop <script> / <style> blocks entirely (email clients strip them anyway).
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Drop any dangling script/style tags.
  out = out.replace(/<\/?(?:script|style)\b[^>]*>/gi, "");
  // Drop the tags that act on the page rather than show content, which no email body
  // needs: <meta> (a refresh redirects every reader of the archive page), <base> (it
  // re-aims every relative link), and <form> (a submit from the app's own origin). A
  // form's fields stay, inert.
  out = out.replace(/<\/?(?:meta|base|form)\b[^>]*>/gi, "");
  // Drop the app's own inert markers (`<!--kestrel:…-->`): the render places them around
  // the post, never inside it, so one in the body could only open or close an email-only
  // region, or stand in for a chrome anchor, and hide part of the post from the archive.
  // Repeated until none is left, so markers nested to reassemble after one pass can't.
  let before: string;
  do {
    before = out;
    out = out.replace(/<!--[\s\S]*?-->/g, (c) => (/kestrel:/i.test(c) ? "" : c));
  } while (out !== before);
  // Strip inline event-handler attributes (onclick, onerror, ...).
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return out;
}
