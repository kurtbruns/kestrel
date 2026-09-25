/**
 * Public reader pages: the landing page at `/` (§5 front door — identity + a
 * subscribe CTA, never a bounce to admin), the archive index at the archive base
 * path (every sent post), and each post page — a sent Send's frozen rendered_html,
 * the reviewed, delivered copy (I3), with edits that leave the content untouched and
 * only fill reserved anchors: the per-recipient unsubscribe sentinel becomes a generic
 * manage-subscription link (a public page has no single recipient), and the inert
 * anchors become browser-only chrome (masthead + the display font and reader ground)
 * that never ships in an email.
 */

import { getBySlug } from "../db/posts";
import { latestSentSendForPost, listPublishedPosts } from "../db/sends";
import { BRANDING_LOGO_KEY, getSettingsForDisplay } from "../db/settings";
import type { Config } from "../env";
import {
  ARCHIVE_POST_HEAD,
  archiveIndexPage,
  htmlPage,
  landingPage,
  type ReaderIdentity,
} from "../lib/page";
import { POST_PAGE_SECURITY_HEADERS } from "../lib/page_headers";
import {
  ARCHIVE_HEAD_ANCHOR,
  ARCHIVE_MASTHEAD_ANCHOR,
  archiveMasthead,
  archiveUrl,
} from "../render/render";
import { fillDeliveryTokens } from "../render/template_engine";
import type { RequestContext } from "../router";
import { param } from "../router";

/** Display name for the publication, from the `From:` header — the fallback when
 *  the operator hasn't set a name in the publication identity. */
function fromDisplayName(fromAddress: string): string {
  const lt = fromAddress.indexOf("<");
  const display = (lt >= 0 ? fromAddress.slice(0, lt) : "").trim().replace(/^"|"$/g, "").trim();
  return display || "Newsletter";
}

/** The resolved publication identity for a reader page: the operator's settings,
 *  falling back to the `From:` display name for the name (shape in `lib/page.ts`). A
 *  corrupt settings row reads as the defaults, so a reader page never fails on it. */
export async function readerIdentity(c: RequestContext, config: Config): Promise<ReaderIdentity> {
  const { publication: p } = await getSettingsForDisplay(c.env.DB);
  return {
    name: p.name || fromDisplayName(config.fromAddress),
    tagline: p.tagline,
    logoUrl: p.logo ? `${config.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
  };
}

function formatSentDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The full archive URL (origin + base path) — the "Browse the full archive" target
 *  and the home of the post list. Built from the same config the route registers at. */
function archiveHomeUrl(config: Config): string {
  return `${config.archiveOrigin}${config.archiveBasePath}`;
}

/** The dev-only "Open dashboard" target for the reader surface, or `undefined` when
 *  not a dev-shaped instance. Only local dev (no Access edge) surfaces this link, so
 *  a deployed public page never points at the Access-gated editor (SPEC §5, §11). */
function devDashboardUrl(config: Config): string | undefined {
  return config.devMode ? `${config.appOrigin}/dashboard/` : undefined;
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
    dateLabel: formatSentDate(i.sent_at),
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

/** The full public archive index: every sent post, newest first, linking to their
 *  permanent (canonical) archive URLs — the same address emails carry. */
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
      dateLabel: formatSentDate(i.sent_at),
    })),
    devDashboardUrl: devDashboardUrl(c.config),
  });
}

export async function archivePage(c: RequestContext): Promise<Response> {
  const slug = param(c, "slug");
  const post = await getBySlug(c.env.DB, slug);
  const send = post ? await latestSentSendForPost(c.env.DB, post.id) : null;
  if (!post || !send) {
    return htmlPage(
      "Not found",
      `<h1 style="margin-top:0;">Not found</h1><p>This post isn't available.</p>`,
      404,
    );
  }
  // Three edits to the frozen record on the way to the browser (I3), all filling
  // reserved anchors — none touches the reviewed content: the generic unsubscribe
  // link (no single recipient here), the browser-only masthead, and the hosted-page
  // <head> chrome (display-serif links + the reader-ground background) — web-only,
  // never in a sent email.
  const identity = await readerIdentity(c, c.config);
  const masthead = archiveMasthead({
    name: identity.name,
    dateLabel: formatSentDate(send.completed_at ?? send.fire_at),
    // Back to the archive index the post belongs to, on the same (archive) origin —
    // so an apex-hosted post stays on the apex instead of jumping to the app subdomain.
    indexUrl: archiveHomeUrl(c.config),
  });
  // Fill the delivery-phase tokens for a recipient-agnostic page: a generic unsubscribe
  // link (no single recipient here) and an empty sent-to address (redacted so none leaks).
  // Same delivery resolver as a real send, one phase later — then swap the inert anchors.
  const html = fillDeliveryTokens(
    send.rendered_html,
    { ".Email.UnsubscribeURL": `${c.config.appOrigin}/unsubscribe`, ".Email.SentTo": "" },
    "html",
  )
    .split(ARCHIVE_MASTHEAD_ANCHOR)
    .join(masthead)
    .split(ARCHIVE_HEAD_ANCHOR)
    .join(ARCHIVE_POST_HEAD);
  return new Response(html, {
    headers: {
      ...POST_PAGE_SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
