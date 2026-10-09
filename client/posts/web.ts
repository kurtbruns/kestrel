// The web-version preview: a post, or the template's sample post, as its public archive
// page will show it once sent (SPEC §5). Where a test email's view-in-browser link leads.
// It fills the window with no chrome of its own, since it opens in a tab of its own; the
// tab's title says what it is.

import type { WebPreviewTarget } from "../../shared/web_preview";
import { apiText } from "../api";
import { mount, onAbort } from "../lifecycle";
import { html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";

/** The page with every link opening a new tab: a link here leads to a public page (the
 *  archive index, the post's own links), which refuses to be framed, so it must leave
 *  the frame rather than blank it. Only the framed copy changes, never the page served. */
export function linksInNewTab(doc: string): string {
  return intoHead(doc, '<base target="_blank">');
}

/** The policy the page carries when served directly (no script, no form, no frame),
 *  restated inside the framed copy, which otherwise has only the editor's own. The
 *  sandbox already keeps script and forms out; this is the second lock. Fonts and images
 *  load as on the page. */
const FRAMED_POLICY =
  "default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'none'; frame-src 'none'";

/** The framed copy of a web-version page: its links open in a new tab, under the policy
 *  the page carries when served. Only the framed copy changes, never the page served. */
export function framedCopy(doc: string): string {
  return intoHead(
    linksInNewTab(doc),
    `<meta http-equiv="Content-Security-Policy" content="${FRAMED_POLICY}">`,
  );
}

/** `markup` placed first in the document's <head> (never a <header>), or first in the
 *  document when it has none. */
function intoHead(doc: string, markup: string): string {
  const head = /<head(\s[^>]*)?>/i;
  return head.test(doc) ? doc.replace(head, (tag) => tag + markup) : markup + doc;
}

/** The route's target from its hash parts (`#/web/post/<id>`, `#/web/template`), or null
 *  for one that names neither. */
export function webTarget(
  kind: string | undefined,
  id: string | undefined,
): WebPreviewTarget | null {
  if (kind === "template") {
    return "template";
  }
  if (kind !== "post" || !id) {
    return null;
  }
  try {
    return { post: decodeURIComponent(id) };
  } catch {
    // A hand-typed or mangled address: no preview, so the router falls through.
    return null;
  }
}

export async function renderWebVersion(
  target: WebPreviewTarget,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const page =
    target === "template"
      ? "/api/settings/template/web"
      : `/api/posts/${encodeURIComponent(target.post)}/web`;
  const appTitle = document.title;
  document.title = "Web version";
  onAbort(signal, () => {
    document.title = appTitle;
  });
  try {
    const doc = await apiText(page, { signal });
    // No script and no form, as the page itself forbids when served (SPEC §5); a link
    // opens in a new tab, under the page's own policy (`framedCopy`).
    setHtml(
      root,
      html`<iframe class="web-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Web version"></iframe>`,
    );
    const frame = root.querySelector<HTMLIFrameElement>(".web-frame");
    if (!frame) {
      return;
    }
    // The page's own <title> is the post's subject (or the sample's).
    frame.onload = () => {
      const subject = frame.contentDocument?.title;
      if (subject && !signal.aborted) {
        document.title = `Web version · ${subject}`;
      }
    };
    frame.srcdoc = framedCopy(doc);
  } catch (e) {
    if (signal.aborted) {
      return;
    }
    setHtml(root, html`<div class="web-error"></div>`);
    const box = root.querySelector(".web-error");
    if (box) {
      renderError(box, e instanceof Error ? e.message : String(e), () =>
        mount((r, s) => renderWebVersion(target, r, s)),
      );
    }
  }
}
