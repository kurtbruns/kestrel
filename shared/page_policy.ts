// The one content security policy for a page carrying a post's HTML (SPEC §5), shared by
// the Worker, which sends it as a header on every page it serves, and the editor, which
// restates it inside a framed copy of such a page, so the two can't drift.
//
// What the pages actually load: inline styles (the email's own, the page chrome's
// <style>), the display font from Google Fonts, and images from anywhere a post may
// point (the media origin, which may be a separate public bucket domain, or any image the
// author linked). Nothing else, and no script, frame, plugin, or base rewrite.

/**
 * The policy, as a header value. `formAction` is the one difference between the kinds of
 * page (a post's page submits no form at all; a page the app wrote posts back to itself).
 * `framed` is the copy the editor frames, carried in a <meta> tag: it leaves out
 * `frame-ancestors`, which a <meta> can't carry, and `base-uri`, which would refuse the
 * <base> the editor adds so a link leaves the frame.
 */
export function pagePolicy(formAction: string, opts: { framed?: boolean } = {}): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    opts.framed ? null : "base-uri 'none'",
    `form-action ${formAction}`,
    opts.framed ? null : "frame-ancestors 'none'",
    "img-src * data:",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
  ]
    .filter((d) => d !== null)
    .join("; ");
}
