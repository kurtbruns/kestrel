// The one spelling of the editor's web-version preview address, shared by the Worker (the
// view-in-browser link in a test and in the editor's preview) and the editor (its router
// and its links), so the link always opens the view that shows it (SPEC §5).

import { dashboardLink } from "./dashboard_link";

/** What a web-version preview shows: one post, or the template's sample post. */
export type WebPreviewTarget = { post: string } | "template";

/** The editor route of a web-version preview, without its `#`. */
function webRoute(target: WebPreviewTarget): string {
  return target === "template" ? "/web/template" : `/web/post/${encodeURIComponent(target.post)}`;
}

/** The editor route (the hash) of a web-version preview. */
export function webPreviewHash(target: WebPreviewTarget): string {
  return `#${webRoute(target)}`;
}

/** The absolute address of a web-version preview on an app origin: inside the editor, so
 *  it opens behind the admin gate whether that is Access or, locally, the dev token, and
 *  carried in the query so a login in between keeps it (`dashboardLink`). */
export function webPreviewUrl(appOrigin: string, target: WebPreviewTarget): string {
  return dashboardLink(appOrigin, webRoute(target));
}
