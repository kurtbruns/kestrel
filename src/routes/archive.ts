/**
 * Public reader pages: the home page at `/` (§5 front door — identity + a
 * subscribe CTA, never a bounce to admin), the archive index at the archive base
 * path (every published post listed in the archive), and each post page — a started Send's frozen rendered_html,
 * the reviewed, delivered copy (I3), with edits that leave the content untouched and
 * only fill reserved anchors: the per-recipient unsubscribe sentinel becomes a generic
 * manage-subscription link (a public page has no single recipient), the inert
 * anchors become browser-only chrome (masthead + the display font and reader ground)
 * that never ships in an email, and the template's email-only regions are left out.
 */

import { getBySlug, getByUnlistedToken, type PostRow } from "../db/posts";
import { listPublishedPosts, publishedSendForPost, type SendRow } from "../db/sends";
import type { Config } from "../env";
import { archiveAnswers } from "../lib/archive_address";
import {
  ARCHIVE_POST_HEAD,
  archiveDevDashboardChrome,
  archiveIndexPage,
  archiveLink,
  landingPage,
  type ReaderIdentity,
  readerIconLink,
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
import { signupsOpen } from "./public";
import { archiveHomeUrl, devDashboardUrl, readerIdentity, readerMessage } from "./reader";

/** A post's date as the reader surface shows it. */
export function formatPublishedDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The public front door (§5): a home page featuring the latest post over a few
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
    signupsOpen: signupsOpen(c.config),
    devDashboardUrl: devDashboardUrl(c.config),
  });
}

/** The full public archive index: every published post (its send has started) listed in the
 *  archive, an email-only post left out (SPEC §5), newest first, linking to their permanent (canonical) archive URLs. */
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
 *  only, the "Open dashboard" pill), and the hosted-page <head> chrome (display-serif links,
 *  the reader ground, and the logo as the tab icon), which never ships in an email. The
 *  public post page and the publisher's web version both build from this, so the web
 *  version is the page. */
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
    .join(ARCHIVE_POST_HEAD + readerIconLink(opts.identity.logoUrl) + dev.head);
}

/** One page for every archive address with no published post (see `archivePage`). */
export function nothingHereYetPage(c: RequestContext): Promise<Response> {
  return readerMessage(c, {
    title: "Nothing here yet",
    eyebrow: "Archive",
    headline: "Nothing here yet",
    ledeHtml: "A post appears here as soon as it’s sent.",
    afterHtml: archiveLink(archiveHomeUrl(c.config), "Browse the archive"),
    status: 404,
  });
}

/** A published post's page, from its send's frozen copy (`webVersion`). `noindex` for an
 *  email-only post: anyone with its link can open it, but no list or search engine is
 *  offered it (SPEC §5). A header, not a meta tag, so the frozen copy is served unchanged (I3). */
async function postPage(c: RequestContext, post: PostRow, send: SendRow): Promise<Response> {
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
      // Checked with the app on every view, since the listing can change at any time: a page
      // taken out of the archive must stop answering at once, and an unlisted link must start
      // forwarding once its post is added (SPEC §5).
      "cache-control": "no-cache",
      ...(post.email_only ? { "x-robots-tag": "noindex" } : {}),
    },
  });
}

/**
 * A post's archive address. It answers only for a published post whose address it is and
 * while the post is listed (`archiveAnswers`); an email-only post's address answers "Nothing
 * here yet" though it stays the post's, unless its email carries this address, as one sent
 * before unlisted links does.
 */
export async function archivePage(c: RequestContext): Promise<Response> {
  const post = await getBySlug(c.env.DB, param(c, "slug"));
  const send = post ? await publishedSendForPost(c.env.DB, post.id) : null;
  if (!post || !send || !archiveAnswers({ emailOnly: post.email_only, webLink: send.web_link })) {
    // One page for every address with no published post, a draft, a scheduled post, an
    // email-only one, or none at all, so it never reveals that a post is on its way or was
    // taken down.
    return nothingHereYetPage(c);
  }
  return postPage(c, post, send);
}

/**
 * A post's unlisted link, the "view in browser" every email of it carries (SPEC §5). Before
 * the post's send starts it answers "Nothing here yet", as any unknown token does. Once it
 * has, a listed post's link forwards to its archive address, temporarily since the listing
 * can change, and an email-only post's link is its page.
 */
export async function unlistedPage(c: RequestContext): Promise<Response> {
  const post = await getByUnlistedToken(c.env.DB, param(c, "token"));
  const send = post ? await publishedSendForPost(c.env.DB, post.id) : null;
  if (!post || !send) {
    return nothingHereYetPage(c);
  }
  // Mail clients' link scanners fetch this on delivery, so the request only reads. The target
  // is the post's own archive address, never anything the request names, so the link can't be
  // used as an open redirect. Not cached, so a listing change takes effect at once, and not
  // indexed, as the unlisted link itself never is.
  if (!post.email_only) {
    return new Response(null, {
      status: 302,
      headers: {
        location: archiveUrl(c.config, post.slug),
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    });
  }
  return postPage(c, post, send);
}
