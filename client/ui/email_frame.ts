// A framed email or page in the editor: the post's Preview tab, its web version, the sample
// email on the Template page and in Settings, and Settings' reader page previews. Its
// sandbox, the policy a framed copy carries, and what its links do.

import { pagePolicy } from "../../shared/page_policy";

// A framed preview is a srcdoc document, whose links resolve against the editor's own URL,
// so a fragment-only link (the sample email's `#unsubscribe` placeholder) names the
// dashboard rather than a spot in the email: followed, it would open the dashboard or load
// it into the frame. The click is refused instead. The listener belongs to the editor, not
// the frame, so it runs even where the frame's sandbox allows no scripts; one shared
// function, so running the helper again on the same link adds nothing.
const stayPut = (e: Event) => e.preventDefault();

/** The sandbox for a frame holding a post's email or page. Same-origin, so the editor can
 *  size the frame and set its links to open a new tab (`openLinksInNewTab`); popups, so
 *  that new tab can open at all; and popups escaping the sandbox, so the page it opens
 *  works as it would from an inbox rather than inheriting this sandbox. Never scripts or
 *  forms: the post's markup does nothing inside the editor but show. */
export const EMAIL_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

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

/** `markup` placed first in the document's <head> (never a <header>), or first in the
 *  document when it has none. */
function intoHead(doc: string, markup: string): string {
  const head = /<head(\s[^>]*)?>/i;
  return head.test(doc) ? doc.replace(head, (tag) => tag + markup) : markup + doc;
}

/** The framed copy of a page (a post's page, a reader page's preview) under the policy a
 *  page that submits no form carries when served (shared/page_policy.ts). The frame's sandbox already keeps script and forms out; the
 *  policy is the second lock. Only the framed copy changes, never the page served. */
export function framedCopy(doc: string): string {
  return intoHead(
    doc,
    `<meta http-equiv="Content-Security-Policy" content="${pagePolicy("'none'", { framed: true })}">`,
  );
}
