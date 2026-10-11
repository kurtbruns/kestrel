/**
 * Public reader pages: the landing page at `/` (§5 front door — identity + a
 * subscribe CTA, never a bounce to admin), the archive index at the archive base
 * path (every published post), and each post page — a started Send's frozen rendered_html,
 * the reviewed, delivered copy (I3), with edits that leave the content untouched and
 * only fill reserved anchors: the per-recipient unsubscribe sentinel becomes a generic
 * manage-subscription link (a public page has no single recipient), the inert
 * anchors become browser-only chrome (masthead + the display font and reader ground)
 * that never ships in an email, and the template's email-only regions are left out.
 */

import { getBySlug } from "../db/posts";
import { listPublishedPosts, publishedSendForPost } from "../db/sends";
import type { Config } from "../env";
import {
  ARCHIVE_POST_HEAD,
  archiveDevDashboardChrome,
  archiveIndexPage,
  archiveLink,
  landingPage,
  type ReaderIdentity,
} from "../lib/page";
import { POST_PAGE_SECURITY_HEADERS } from "../lib/page_headers";
import {
  ARCHIVE_HEAD_ANCHOR,
  ARCHIVE_MASTHEAD_ANCHOR,
  archiveMasthead,
  archiveUrl,
  omitEmailOnly,
} from "../render/render";
import { fillDeliveryTokens } from "../render/template_engine";
import type { RequestContext } from "../router";
import { param } from "../router";
import { archiveHomeUrl, devDashboardUrl, readerIdentity, readerMessage } from "./reader";

function formatPublishedDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The public front door (§5): a landing page featuring the latest post over a few
 *  recent ones, with the publication identity and a subscribe call to action. Never
 *  bounces a visitor toward an admin path (§11). */
export async function landing(c: RequestContext): Promise<Response> {
  const [posts, identity] = await Promise.all([
    listPublishedPosts(c.env.DB, 6),
    readerIdentity(c, c.config),
  ]);
  const mapped = posts.map((i) => ({
    title: i.subject,
    url: archiveUrl(c.config, i.slug),
    dateLabel: formatPublishedDate(i.published_at),
  }));
  const [featured, ...recent] = mapped;
  return landingPage({
    identity,
    subscribeUrl: `${c.config.appOrigin}/subscribe`,
    homeUrl: `${c.config.appOrigin}/`,
    archiveUrl: archiveHomeUrl(c.config),
    featured,
    recent,
    devDashboardUrl: devDashboardUrl(c.config),
  });
}

/** The full public archive index: every published post (its send has started), newest
 *  first, linking to their permanent (canonical) archive URLs — the same address emails carry. */
export async function archiveIndex(c: RequestContext): Promise<Response> {
  const [posts, identity] = await Promise.all([
    listPublishedPosts(c.env.DB),
    readerIdentity(c, c.config),
  ]);
  return archiveIndexPage({
    identity,
    subscribeUrl: `${c.config.appOrigin}/subscribe`,
    homeUrl: `${c.config.appOrigin}/`,
    posts: posts.map((i) => ({
      title: i.subject,
      url: archiveUrl(c.config, i.slug),
      dateLabel: formatPublishedDate(i.published_at),
    })),
    devDashboardUrl: devDashboardUrl(c.config),
  });
}

/** A frozen email as its post page shows it (SPEC §5, I3). Four edits, all at reserved
 *  markers, none touching the reviewed content: the per-recipient slots filled for no one
 *  (the generic unsubscribe link, and an empty sent-to address so none leaks), the
 *  template's email-only regions left out, the browser-only masthead (plus, in local dev
 *  only, the "Open dashboard" pill), and the hosted-page <head> chrome (display-serif links
 *  and the reader ground), which never ships in an email. The public post page and the
 *  publisher's web version both build from this, so the web version is the page. */
export function webVersion(
  html: string,
  opts: {
    config: Config;
    identity: ReaderIdentity;
    /** The date the masthead carries: when the post went out, or will. */
    dateMs: number;
    devDashboardUrl?: string;
  },
): string {
  const masthead = archiveMasthead({
    name: opts.identity.name,
    dateLabel: formatPublishedDate(opts.dateMs),
    // Back to the archive index the post belongs to, on the same (archive) origin —
    // so an apex-hosted post stays on the apex instead of jumping to the app subdomain.
    indexUrl: archiveHomeUrl(opts.config),
  });
  const dev = archiveDevDashboardChrome(opts.devDashboardUrl);
  // Same delivery resolver as a real send, one phase later — then swap the inert anchors.
  return fillDeliveryTokens(
    omitEmailOnly(html),
    { ".Email.UnsubscribeURL": `${opts.config.appOrigin}/unsubscribe`, ".Email.SentTo": "" },
    "html",
  )
    .split(ARCHIVE_MASTHEAD_ANCHOR)
    .join(masthead + dev.masthead)
    .split(ARCHIVE_HEAD_ANCHOR)
    .join(ARCHIVE_POST_HEAD + dev.head);
}

export async function archivePage(c: RequestContext): Promise<Response> {
  const slug = param(c, "slug");
  const post = await getBySlug(c.env.DB, slug);
  const send = post ? await publishedSendForPost(c.env.DB, post.id) : null;
  if (!post || !send) {
    // One page for every address with no published post, a draft, a scheduled post, or
    // none at all, so it never reveals that a post is on its way. A test email's "view
    // in browser" link lands here until the send starts.
    return readerMessage(c, {
      title: "Nothing here yet",
      eyebrow: "Archive",
      headline: "Nothing here yet",
      ledeHtml: "A post appears here as soon as it’s sent.",
      afterHtml: archiveLink(archiveHomeUrl(c.config), "Browse the archive"),
      status: 404,
    });
  }
  const html = webVersion(send.rendered_html, {
    config: c.config,
    identity: await readerIdentity(c, c.config),
    dateMs: send.started_at ?? send.fire_at,
    devDashboardUrl: devDashboardUrl(c.config),
  });
  return new Response(html, {
    headers: {
      ...POST_PAGE_SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
