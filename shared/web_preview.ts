// The one spelling of the editor's web-version preview address, shared by the Worker (a
// test email's view-in-browser link) and the editor (its router and its links), so the
// link a test carries always opens the view that shows it (SPEC §5).

/** What a web-version preview shows: one post, or the template's sample post. */
export type WebPreviewTarget = { post: string } | "template";

/** The target's path under `#/web/` (and the `web` query value): `post/<id>` or `template`. */
function targetPath(target: WebPreviewTarget): string {
  return target === "template" ? "template" : `post/${encodeURIComponent(target.post)}`;
}

/** The editor route (the hash) of a web-version preview. */
export function webPreviewHash(target: WebPreviewTarget): string {
  return `#/web/${targetPath(target)}`;
}

/** The absolute address of a web-version preview on an app origin: inside the editor, so
 *  it opens behind the admin gate whether that is Access or, locally, the dev token. The
 *  target rides in the query, not the hash, because a browser never sends the hash to the
 *  server: an Access login in between would return to the editor's home without it. The
 *  editor turns the query into its route at boot (`webPreviewHashFromSearch`). */
export function webPreviewUrl(appOrigin: string, target: WebPreviewTarget): string {
  return `${appOrigin}/dashboard/?web=${encodeURIComponent(targetPath(target))}`;
}

/** The editor route a `?web=` query names, or null when it names no preview. */
export function webPreviewHashFromSearch(search: string): string | null {
  const web = new URLSearchParams(search).get("web");
  if (web === "template") {
    return webPreviewHash("template");
  }
  const id = web?.startsWith("post/") ? web.slice("post/".length) : "";
  return id && !id.includes("/") ? webPreviewHash({ post: decodeOr(id) }) : null;
}

/** `decodeURIComponent`, or the input as it is when it isn't validly encoded. */
function decodeOr(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
