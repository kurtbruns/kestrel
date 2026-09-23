/**
 * The security headers every HTML page the Worker serves carries: the reader pages,
 * the archive's post pages, and the publisher's preview (SPEC §5). A post page is the
 * frozen email, whose HTML the author wrote (or Claude did, from whatever it read), and
 * it is served from the app's own origin, beside the admin API. The render's sanitizer
 * is not a security boundary, so this policy is: no script of any kind runs on these
 * pages, and none of them can be framed by another site.
 */

// What the pages actually load: inline styles (the email's own, the page chrome's
// <style>), the display font from Google Fonts, and images from anywhere a post may
// point (the media origin, which may be a separate public bucket domain, or any image
// the author linked). Nothing else, and no script, frame, plugin, or base rewrite.
const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src * data:",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
].join("; ");

/** Headers for an HTML page: the strict CSP, no framing, and no content sniffing. */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};
