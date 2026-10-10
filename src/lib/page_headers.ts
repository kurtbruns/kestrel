/**
 * The security headers every HTML page the Worker serves carries: the reader pages,
 * the archive's post pages, and the publisher's preview (SPEC §5). A post page is the
 * frozen email, whose HTML the author wrote (or Claude did, from whatever it read), and
 * it is served from the app's own origin, beside the admin API. The render's sanitizer
 * is not a security boundary, so this policy is: no script of any kind runs on these
 * pages, and none of them can be framed by another site.
 */

import { pagePolicy } from "../../shared/page_policy";

// The policy itself (what the pages load, and that no script runs) lives in shared/, so
// the editor's framed copy of a post page restates exactly this.
function headers(formAction: string): Readonly<Record<string, string>> {
  return {
    "content-security-policy": pagePolicy(formAction),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  };
}

/** Headers for a page the app wrote itself (the landing page, the archive index, the
 *  subscribe and unsubscribe cards): its own forms post back to the app. */
export const PAGE_SECURITY_HEADERS = headers("'self'");

/**
 * Headers for a page carrying a post's HTML (a post page, the preview): no form may
 * submit at all. The page is on the admin API's origin, where a publisher's browser
 * carries their session, so a form in a post's body posting to an admin route would act
 * as them. The page has no form of its own to lose.
 */
export const POST_PAGE_SECURITY_HEADERS = headers("'none'");
