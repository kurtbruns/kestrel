/**
 * Public archive / "view in browser" pages. The index at `/` lists past issues
 * (§10 — the self-contained front door, never a bounce to admin); each issue
 * page serves a sent Send's frozen rendered_html VERBATIM — the page a reader
 * opens is the exact copy that was reviewed and delivered (I3). The only edit is
 * substituting the per-recipient unsubscribe sentinel with a generic
 * manage-subscription link (a public page has no single recipient).
 */
import type { RequestContext } from "../router";
import { param } from "../router";
import { htmlPage, archiveIndexPage } from "../lib/page";
import { getBySlug } from "../db/posts";
import { latestSentSendForPost, listPublishedIssues } from "../db/sends";
import { UNSUB_SENTINEL, archiveUrl } from "../render/render";

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
    return htmlPage("Not found", `<h1 style="margin-top:0;">Not found</h1><p>This issue isn't available.</p>`, 404);
  }
  const html = send.rendered_html.split(UNSUB_SENTINEL).join(`${c.config.appOrigin}/unsubscribe`);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
