/**
 * Public archive / "view in browser" pages. The index at `/` lists past issues
 * (§10 — the self-contained front door, never a bounce to admin); each issue
 * page serves a sent Send's frozen rendered_html — the reviewed, delivered copy
 * (I3) — with two edits that leave the content untouched: the per-recipient
 * unsubscribe sentinel becomes a generic manage-subscription link (a public page
 * has no single recipient), and the inert masthead anchor becomes a browser-only
 * masthead (publication name + publish date), chrome that never ships in an email.
 */

import { getBySlug } from "../db/posts";
import { latestSentSendForPost, listPublishedIssues } from "../db/sends";
import { archiveIndexPage, htmlPage } from "../lib/page";
import {
  ARCHIVE_MASTHEAD_ANCHOR,
  archiveMasthead,
  archiveUrl,
  UNSUB_SENTINEL,
} from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";

/** Display name for the publication, from the `From:` header (no separate var). */
function publicationName(fromAddress: string): string {
  const lt = fromAddress.indexOf("<");
  const display = (lt >= 0 ? fromAddress.slice(0, lt) : "").trim().replace(/^"|"$/g, "").trim();
  return display || "Newsletter";
}

function formatSentDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Public archive index: past issues, newest first, linking to their permanent
 *  (canonical) archive URLs — the same address emails carry. */
export async function archiveIndex(c: RequestContext): Promise<Response> {
  const issues = await listPublishedIssues(c.env.DB);
  return archiveIndexPage({
    name: publicationName(c.config.fromAddress),
    subscribeUrl: `${c.config.appOrigin}/subscribe`,
    issues: issues.map((i) => ({
      title: i.subject,
      url: archiveUrl(c.config, i.slug),
      dateLabel: formatSentDate(i.sent_at),
    })),
  });
}

export async function archivePage(c: RequestContext): Promise<Response> {
  const slug = param(c, "slug");
  const post = await getBySlug(c.env.DB, slug);
  const send = post ? await latestSentSendForPost(c.env.DB, post.id) : null;
  if (!post || !send) {
    return htmlPage(
      "Not found",
      `<h1 style="margin-top:0;">Not found</h1><p>This issue isn't available.</p>`,
      404,
    );
  }
  // Two edits to the frozen record on the way to the browser (I3): the generic
  // unsubscribe link (no single recipient here) and the browser-only masthead
  // swapped in for its inert anchor. Neither touches the reviewed content.
  const masthead = archiveMasthead({
    name: publicationName(c.config.fromAddress),
    dateLabel: formatSentDate(send.completed_at ?? send.fire_at),
    indexUrl: `${c.config.appOrigin}/`,
  });
  const html = send.rendered_html
    .split(UNSUB_SENTINEL)
    .join(`${c.config.appOrigin}/unsubscribe`)
    .split(ARCHIVE_MASTHEAD_ANCHOR)
    .join(masthead);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
