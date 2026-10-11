// Links in a framed email preview: the post's Preview tab, and the sample email on the
// Template page and in Settings.

/** Every link in a framed email made to open a new tab, with no opener and no referrer.
 *  Followed in the frame, a link would load its target there, and most targets (the app's
 *  own pages among them) refuse to be framed, so the frame would go blank and the preview
 *  be lost. Run it whenever the frame's content changes. A sandboxed frame also needs
 *  `allow-popups` for the new tab to open at all. */
export function openLinksInNewTab(doc: Document): void {
  for (const link of doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
    "a[href], area[href]",
  )) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
