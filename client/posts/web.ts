// The web-version preview: a post, or the template's sample post, as its public archive
// page will show it once sent (SPEC §5). Where a test email's view-in-browser link leads.
// It opens in a tab of its own, so it carries no app chrome: one thin bar above the page
// says what it is and where the post's public page is, or will be, so the copy is never
// mistaken for the live page, and the frame below holds the page exactly as it will be.

import { pagePolicy } from "../../shared/page_policy";
import type { PostResponse } from "../../shared/posts";
import type { WebPreviewTarget } from "../../shared/web_preview";
import { api, apiText } from "../api";
import { postArchiveUrl } from "../deployment";
import { mount, onAbort } from "../lifecycle";
import { type Html, html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";

/** The page with every link opening a new tab: a link in a framed page (the archive index,
 *  the web version, a post's own links) may lead to a page that refuses to be framed, so
 *  it must leave the frame rather than blank it. Only the framed copy changes, never the
 *  page served. */
export function linksInNewTab(doc: string): string {
  return intoHead(doc, '<base target="_blank">');
}

/** A link's `rel="opener"` taken out, so a tab a framed link opens never gets a handle on
 *  the frame, which shares the editor's origin. Every other `rel` token stays. */
function withoutOpener(doc: string): string {
  return doc.replace(/\brel\s*=\s*(["'])([^"']*)\1/gi, (_m, q: string, value: string) => {
    const kept = value.split(/\s+/).filter((t) => t !== "" && t.toLowerCase() !== "opener");
    return `rel=${q}${kept.join(" ")}${q}`;
  });
}

/** The framed copy of a post's page (the web version, or the editor's email preview): its
 *  links open in a new tab and never as an opener, under the policy the page carries when
 *  served (shared/page_policy.ts). The sandbox already keeps script and forms out; the
 *  policy is the second lock. Only the framed copy changes, never the page served. */
export function framedCopy(doc: string): string {
  return intoHead(
    linksInNewTab(withoutOpener(doc)),
    `<meta http-equiv="Content-Security-Policy" content="${pagePolicy("'none'", { framed: true })}">`,
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

/** Where the previewed page stands, for the bar: the template's sample, or a post by its
 *  status and public address (null while unknown, so the bar names no address). */
export type WebBarState =
  | { kind: "template" }
  | { kind: "post"; status: "draft" | "scheduled" | "sent"; url: string | null };

/** The bar's words: what the page is, and where the post's public page is or will be. A
 *  sent post's address is a link (it answers); an unsent one's is text, since it doesn't. */
export function webBar(state: WebBarState | null): Html {
  const label = html`<strong>Web version</strong>`;
  if (state === null) {
    return label;
  }
  if (state.kind === "template") {
    return html`${label}<span>The sample post, with the saved template, as an archive page shows it</span>`;
  }
  const { status, url } = state;
  if (status === "sent") {
    const at =
      url && /^https?:\/\//.test(url)
        ? html` at <a href="${url}" target="_blank" rel="noopener">${url}</a>`
        : null;
    return html`${label}<span>Sent. Published${at}</span>`;
  }
  const when = status === "scheduled" ? "Scheduled, not sent yet." : "Not sent yet.";
  const where = url ? html` Its page will be at <span class="web-url">${url}</span>` : null;
  return html`${label}<span>${when}${where}</span>`;
}

/** The bar's state for a target: the post's status and address from its read, or null
 *  when the read fails (the bar then says only what the page is). */
async function barState(
  target: WebPreviewTarget,
  signal: AbortSignal,
): Promise<WebBarState | null> {
  if (target === "template") {
    return { kind: "template" };
  }
  try {
    const { post } = await api<PostResponse>(`/api/posts/${encodeURIComponent(target.post)}`, {
      signal,
    });
    return { kind: "post", status: post.status, url: postArchiveUrl(post.slug) };
  } catch {
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
    const [doc, state] = await Promise.all([apiText(page, { signal }), barState(target, signal)]);
    // No script and no form, as the page itself forbids when served (SPEC §5); a link
    // opens in a new tab, under the page's own policy (`framedCopy`).
    setHtml(
      root,
      html`<div class="web-page">
        <div class="web-bar" role="note">${webBar(state)}</div>
        <iframe class="web-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Web version"></iframe>
      </div>`,
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
