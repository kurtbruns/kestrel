// The one spelling of the editor's web-version preview address, shared by the Worker (a
// test email's view-in-browser link) and the editor (its router and its links), so the
// link a test carries always opens the view that shows it (SPEC §5).

/** What a web-version preview shows: one post, or the template's sample post. */
export type WebPreviewTarget = { post: string } | "template";

/** The editor route (the hash) of a web-version preview. */
export function webPreviewHash(target: WebPreviewTarget): string {
  return target === "template" ? "#/web/template" : `#/web/post/${encodeURIComponent(target.post)}`;
}

/** The absolute address of a web-version preview on an app origin: inside the editor, so
 *  it opens behind the admin gate whether that is Access or, locally, the dev token. */
export function webPreviewUrl(appOrigin: string, target: WebPreviewTarget): string {
  return `${appOrigin}/dashboard/${webPreviewHash(target)}`;
}
