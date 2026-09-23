/**
 * Email-HTML hygiene pass — NOT a hardened XSS sanitizer.
 *
 * Authors are trusted (only the operator + Claude, behind auth), so this is
 * defense-in-depth for the public archive, not a security boundary. It removes
 * the highest-risk, never-legitimate constructs and nothing else, so it won't
 * mangle real content. This is the single seam where a full allowlist sanitizer
 * would drop in if authorship ever widens.
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
  // Strip inline event-handler attributes (onclick, onerror, ...).
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize script URL schemes wherever they appear in attributes.
  out = out.replace(/(javascript|vbscript)\s*:/gi, "unsafe:");
  return out;
}
