// The web-version preview: a post, or the template's sample post, as its public archive
// page will show it once sent (SPEC §5). Where a test email's view-in-browser link leads.
// It opens in a tab of its own, so it carries no app chrome: one thin bar above the page
// says what it is, where the post stands, and where its public page will be, so the copy
// is never mistaken for the live page, and the frame below holds the page exactly as it
// will be. Once the post is sent, the public page itself is the web version.

import { pagePolicy } from "../../shared/page_policy";
import type { PostResponse } from "../../shared/posts";
import type { WebPreviewTarget } from "../../shared/web_preview";
import { api, apiText } from "../api";
import { postArchiveUrl } from "../deployment";
import { mount, onAbort } from "../lifecycle";
import { fmt } from "../ui/format";
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

/** Where the previewed page stands, for the bar: the template's sample, or a post by
 *  where its send is and its public address (null while unknown, so the bar names none). */
export type WebBarState =
  | { kind: "template" }
  | {
      kind: "post";
      stage: "draft" | "scheduled" | "sending" | "sent";
      /** The scheduled send's fire time, for a scheduled post. */
      fireAt: number | null;
      url: string | null;
    };

/** An address as the bar shows it: without its scheme, which says nothing to a reader. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** The bar's words: what the page is, where the post stands, and where its public page
 *  will be (as text, since it doesn't answer yet), with the way to the editor at its end. */
export function webBar(state: WebBarState | null, editHref: string): Html {
  const label = html`<strong>Web version</strong>`;
  const edit = html`<a class="web-edit" href="${editHref}">${state?.kind === "template" ? "Edit template" : "Edit post"}</a>`;
  if (state === null) {
    return html`${label}${edit}`;
  }
  if (state.kind === "template") {
    return html`${label}<span>The sample post, with your saved template</span>${edit}`;
  }
  const at = state.url ? html`<span class="web-url">${shortUrl(state.url)}</span>` : null;
  const where = (lead: string, tail = ".") => (at ? html` ${lead} ${at}${tail}` : null);
  let words: Html;
  switch (state.stage) {
    case "scheduled":
      words = html`Sends ${fmt(state.fireAt)}.${where("It will be at")}`;
      break;
    case "sending":
      words = html`Sending now.${where("It will be at", " once the send finishes.")}`;
      break;
    case "sent":
      words = html`Published.`;
      break;
    default:
      words = html`Not published yet.${where("It will be at")}`;
  }
  return html`${label}<span>${words}</span>${edit}`;
}

/** The bar's state for a post: where its send is, from its read, or null when the read
 *  fails (the bar then says only what the page is). */
async function postState(post: string, signal: AbortSignal): Promise<WebBarState | null> {
  try {
    const data = await api<PostResponse>(`/api/posts/${encodeURIComponent(post)}`, { signal });
    const stage = data.sending
      ? "sending"
      : data.post.status === "sent"
        ? "sent"
        : data.scheduled
          ? "scheduled"
          : "draft";
    return {
      kind: "post",
      stage,
      fireAt: data.scheduled?.fire_at ?? null,
      url: postArchiveUrl(data.post.slug),
    };
  } catch {
    return null;
  }
}

/** Leave for another page, replacing this one in the history (so Back skips it). */
export function leaveFor(url: string): void {
  location.replace(url);
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
    const [doc, state] = await Promise.all([
      apiText(page, { signal }),
      target === "template" ? ({ kind: "template" } as const) : postState(target.post, signal),
    ]);
    // A sent post's page is public now: its web version is that page, so go there. An old
    // test email's link then lands on exactly what readers see.
    if (state?.kind === "post" && state.stage === "sent" && state.url && !signal.aborted) {
      leaveFor(state.url);
      return;
    }
    const editHref =
      target === "template" ? "#/template" : `#/edit/${encodeURIComponent(target.post)}`;
    // No script and no form, as the page itself forbids when served (SPEC §5); a link
    // opens in a new tab, under the page's own policy (`framedCopy`).
    setHtml(
      root,
      html`<div class="web-page">
        <div class="web-bar" role="note">${webBar(state, editHref)}</div>
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
