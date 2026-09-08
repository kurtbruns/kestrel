/**
 * Public archive / "view in browser" page. Serves a sent Send's frozen
 * rendered_html VERBATIM — the page a reader opens is the exact copy that was
 * reviewed and delivered (I3). The only edit is substituting the per-recipient
 * unsubscribe sentinel with a generic manage-subscription link (a public page
 * has no single recipient).
 */
import type { RequestContext } from "../router";
import { param } from "../router";
import { htmlPage } from "../lib/page";
import { getBySlug } from "../db/posts";
import { latestSentSendForPost } from "../db/sends";
import { UNSUB_SENTINEL } from "../render/render";

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
