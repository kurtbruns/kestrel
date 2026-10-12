// A post's web version: the post as its public post page will show it (SPEC §5), for the
// publisher to proof before it is permanent. It opens in a tab of its own from the editor's
// Web version link, so it carries no app chrome: one strip in the brand accent above the
// page says what it is, where the post stands, and where its public page will be, so the
// copy is never mistaken for the live page, and the frame below holds the page exactly as
// it will be. The strip is the editor's, outside the frame, so it stays while the post
// scrolls and the framed page is the public page's bytes.
// Once the post's send starts, the public page itself is the web version.

import type { PostResponse } from "../../shared/posts";
import { ApiError, api, apiText } from "../api";
import { postArchiveUrl } from "../deployment";
import { mount, onAbort } from "../lifecycle";
import { EMAIL_FRAME_SANDBOX, framedCopy, openLinksInNewTab } from "../ui/email_frame";
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

/** The bar's words: what the page is, as its tag, then where the post stands and where it
 *  will be published (as text, since the address doesn't answer yet), with no date. Null
 *  state: the post couldn't be read, so the bar says only what the page is. */
export function webBar(state: WebBarState | null): Html {
  const tag = html`<span class="web-bar-tag">Web version</span>`;
  if (state === null) {
    return tag;
  }
  const stage = state.scheduled ? "Scheduled" : "Draft";
  const at = state.url ? html` · will be published at ${shortUrl(state.url)}` : null;
  return html`${tag} <span class="web-bar-text">${stage}${at}</span>`;
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
    const bar = webBar(data ? { scheduled: data.scheduled != null, url } : null);
    setHtml(
      root,
      html`<div class="web-page">
        <div class="web-bar" role="note"><div class="web-bar-in">${bar}</div></div>
        <iframe class="web-frame" sandbox="${EMAIL_FRAME_SANDBOX}" title="Web version" scrolling="no"></iframe>
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
      // The frame is as tall as the post, so the window scrolls the page and the strip
      // above goes up with it rather than staying pinned. Measured on the body, which is
      // content-sized, and kept fitted as fonts, images, and the window's width change it.
      const fitFrame = () => {
        const h = page.body?.scrollHeight;
        if (h) {
          frame.style.height = `${h}px`;
        }
      };
      fitFrame();
      if (page.body && typeof ResizeObserver !== "undefined") {
        const watch = new ResizeObserver(fitFrame);
        watch.observe(page.body);
        onAbort(signal, () => watch.disconnect());
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
      // The API names only what it didn't find ("post"), which says nothing on its own.
      const notFound = e instanceof ApiError && e.status === 404;
      const msg = notFound
        ? "There’s no post here. It may have been deleted."
        : e instanceof Error
          ? e.message
          : String(e);
      renderError(box, msg, () => mount((r, s) => renderWebVersion(id, r, s)));
    }
  }
}
