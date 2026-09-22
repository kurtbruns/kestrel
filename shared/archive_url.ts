// The one spelling of a post's public archive URL, shared by the Worker (emails, the
// reader surface, the API) and the editor, so the two can never disagree (SPEC §5).

/** The canonical archive URL of a post: `<origin><basePath>/<slug>`. */
export function archivePostUrl(origin: string, basePath: string, slug: string): string {
  return `${origin}${basePath}/${slug}`;
}
