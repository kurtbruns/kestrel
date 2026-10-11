// Links in a framed email preview: the post's Preview tab, and the sample email on the
// Template page and in Settings.

// A framed preview is a srcdoc document, whose links resolve against the editor's own URL,
// so a fragment-only link (the sample email's `#unsubscribe` placeholder) names the
// dashboard rather than a spot in the email: followed, it would open the dashboard or load
// it into the frame. The click is refused instead. The listener belongs to the editor, not
// the frame, so it runs even where the frame's sandbox allows no scripts; one shared
// function, so running the helper again on the same link adds nothing.
const stayPut = (e: Event) => e.preventDefault();

/** Every link in a framed email made to open a new tab, with no opener and no referrer.
 *  Followed in the frame, a link would load its target there, and most targets (the app's
 *  own pages among them) refuse to be framed, so the frame would go blank and the preview
 *  be lost. A fragment-only link does nothing instead (`stayPut`). Run it whenever the
 *  frame's content changes. A sandboxed frame also needs `allow-popups` for the new tab to
 *  open at all. */
export function openLinksInNewTab(doc: Document): void {
  for (const link of doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
    "a[href], area[href]",
  )) {
    if (link.getAttribute("href")?.startsWith("#")) {
      link.addEventListener("click", stayPut);
      link.addEventListener("auxclick", stayPut);
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
