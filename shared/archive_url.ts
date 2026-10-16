// The one spelling of a post's two public addresses, shared by the Worker (emails, the reader
// surface, the API) and the editor, so the two can never disagree (SPEC §5).

/** The canonical archive URL of a post: `<origin><basePath>/<slug>`. */
export function archivePostUrl(origin: string, basePath: string, slug: string): string {
  return `${origin}${basePath}/${slug}`;
}

/** The path every unlisted link sits under, on the app's own origin. */
export const UNLISTED_PATH = "/email";

/**
 * A post's unlisted link, `<app origin>/email/<token>`: what every email of it carries as
 * "view in browser". On the app's origin, never the archive's, so moving the archive (its
 * origin or base path) breaks no email already sent.
 */
export function unlistedPostUrl(appOrigin: string, token: string): string {
  return `${appOrigin}${UNLISTED_PATH}/${token}`;
}
