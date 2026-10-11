// A post's web version: the post as its public post page will show it (SPEC §5), for the
// publisher to proof before it is permanent. It opens in a tab of its own from the editor's
// Web version link, so it carries no app chrome: one thin bar above the page says what it
// is, where the post stands, and where its public page will be, so the copy is never
// mistaken for the live page, and the frame below holds the page exactly as it will be.
// Once the post's send starts, the public page itself is the web version.

import { pagePolicy } from "../../shared/page_policy";
import type { PostResponse } from "../../shared/posts";
import { api, apiText } from "../api";
import { postArchiveUrl } from "../deployment";
import { mount, onAbort } from "../lifecycle";
import { EMAIL_FRAME_SANDBOX, openLinksInNewTab } from "../ui/email_frame";
import { type Html, html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";
import { savesSettled } from "./pending_save";

/** The editor route (the hash) of a post's web version. */
export function webVersionHash(postId: string): string {
  return `#/web/post/${encodeURIComponent(postId)}`;
}

/** The post id a web-version route names (`#/web/post/<id>`, split into its parts), or null
 *  for one that names none, so the router falls through. */
export function webPostId(kind: string | undefined, id: string | undefined): string | null {
  if (kind !== "post" || !id) {
    return null;
  }
  try {
    return decodeURIComponent(id);
  } catch {
    // A hand-typed or mangled address: no page, never a throw.
    return null;
  }
}

/** `markup` placed first in the document's <head> (never a <header>), or first in the
 *  document when it has none. */
function intoHead(doc: string, markup: string): string {
  const head = /<head(\s[^>]*)?>/i;
  return head.test(doc) ? doc.replace(head, (tag) => tag + markup) : markup + doc;
}

/** The framed copy of a post's page, under the policy the page carries when served
 *  (shared/page_policy.ts). The frame's sandbox already keeps script and forms out; the
 *  policy is the second lock. Only the framed copy changes, never the page served. */
export function framedCopy(doc: string): string {
  return intoHead(
    doc,
    `<meta http-equiv="Content-Security-Policy" content="${pagePolicy("'none'", { framed: true })}">`,
  );
}

/** Where a post stands, for the bar: a draft or scheduled, and its public address (null
 *  while unknown, so the bar names none). */
export interface WebBarState {
  scheduled: boolean;
  url: string | null;
}

/** An address as the bar shows it: without its scheme, which says nothing to a reader. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** The bar's words: what the page is, where the post stands, and where its public page will
 *  be once sent (as text, since it doesn't answer yet), with no date. Null state: the post
 *  couldn't be read, so the bar says only what the page is. */
export function webBar(state: WebBarState | null): Html {
  const label = html`<strong>Web version</strong>`;
  if (state === null) {
    return label;
  }
  const lead = state.scheduled ? html`Scheduled.` : html`Draft.`;
  const at = state.url
    ? html` Once sent, it will be at <span class="web-url">${shortUrl(state.url)}</span>.`
    : null;
  return html`${label} <span>${lead}${at}</span>`;
}

/** The same address, spelled one way, or null for one that is not a whole URL. */
function normalUrl(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/** In the Preview tab of an unpublished post, every link to the post's own public address
 *  (its "View in browser" link) made to open its web version instead (SPEC §5). That address
 *  answers "Nothing here yet" until the send starts, so a publisher who follows it to see
 *  the post's page would find none; the web version is that page. Only the framed copy
 *  changes: the email's bytes, and every test and send of it, keep the public address.
 *  Links to anywhere else, another post's page among them, are left as they are. Only
 *  the address changes: `openLinksInNewTab` still opens the link in a new tab. */
export function previewOpensWebVersion(
  doc: Document,
  archiveUrl: string | null,
  webUrl: string,
): void {
  const own = archiveUrl ? normalUrl(archiveUrl) : null;
  if (!own) {
    return;
  }
  for (const link of doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
    "a[href], area[href]",
  )) {
    const href = link.getAttribute("href");
    if (href && normalUrl(href) === own) {
      link.setAttribute("href", webUrl);
    }
  }
}

/** Leave for another page, replacing this one in the history (so Back skips it). */
export function leaveFor(url: string): void {
  location.replace(url);
}

/** The post's read, or null when it fails (the page still shows, under a bar that names no
 *  stage or address). */
async function readPost(id: string, signal: AbortSignal): Promise<PostResponse | null> {
  try {
    return await api<PostResponse>(`/api/posts/${encodeURIComponent(id)}`, { signal });
  } catch {
    return null;
  }
}

export async function renderWebVersion(
  id: string,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const appTitle = document.title;
  document.title = "Web version";
  onAbort(signal, () => {
    document.title = appTitle;
  });
  try {
    // Opened in place from the editor, the click's save may still be going: read after it.
    await savesSettled();
    const [doc, data] = await Promise.all([
      apiText(`/api/posts/${encodeURIComponent(id)}/web`, { signal }),
      readPost(id, signal),
    ]);
    if (signal.aborted) {
      return;
    }
    const url = data ? postArchiveUrl(data.post.slug) : null;
    // Once the send starts the post is public, and its web version is that page: go there.
    if (data && (data.sending || data.post.status === "sent") && url) {
      leaveFor(url);
      return;
    }
    const state = data ? { scheduled: data.scheduled != null, url } : null;
    setHtml(
      root,
      html`<div class="web-page">
        <div class="web-bar" role="note">${webBar(state)}</div>
        <iframe class="web-frame" sandbox="${EMAIL_FRAME_SANDBOX}" title="Web version"></iframe>
      </div>`,
    );
    const frame = root.querySelector<HTMLIFrameElement>(".web-frame");
    if (!frame) {
      return;
    }
    // A link opens a new tab, as in the Preview tab, and the page's own <title> is the
    // post's subject.
    frame.onload = () => {
      const page = frame.contentDocument;
      if (!page || signal.aborted) {
        return;
      }
      openLinksInNewTab(page);
      if (page.title) {
        document.title = `Web version · ${page.title}`;
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
        mount((r, s) => renderWebVersion(id, r, s)),
      );
    }
  }
}
