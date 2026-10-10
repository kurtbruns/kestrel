/**
 * Public reader pages: the landing page at `/` (§5 front door — identity + a
 * subscribe CTA, never a bounce to admin), the archive index at the archive base
 * path (every sent post), and each post page — a sent Send's frozen rendered_html,
 * the reviewed, delivered copy (I3), with edits that leave the content untouched and
 * only fill reserved anchors: the per-recipient unsubscribe sentinel becomes a generic
 * manage-subscription link (a public page has no single recipient), the inert
 * anchors become browser-only chrome (masthead + the display font and reader ground)
 * that never ships in an email, and the template's email-only regions are left out.
 */

import { getBySlug } from "../db/posts";
import { latestSentSendForPost, listPublishedPosts } from "../db/sends";
import { BRANDING_LOGO_KEY, getSettingsForDisplay } from "../db/settings";
import type { Config } from "../env";
import {
  ARCHIVE_POST_HEAD,
  archiveDevDashboardChrome,
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
  omitEmailOnly,
  publicViewInBrowserUrl,
} from "../render/render";
import { fillDeliveryTokens, fillSendTokens } from "../render/template_engine";
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
export function devDashboardUrl(config: Config): string | undefined {
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

/** The web version of a frozen email, as its archive page shows it (SPEC §5, I3): every
 *  edit made at a reserved marker, none touching the reviewed content. The view-in-browser
 *  link points at the post's public page, the per-recipient slots are filled for no one
 *  (the generic unsubscribe link, and an empty sent-to address so none leaks), the
 *  template's email-only regions are left out, and the browser-only chrome fills its
 *  anchors: the masthead (plus, in local dev only, the "Open dashboard" pill) and the
 *  hosted-page <head> (display-serif links and the reader ground). The archive page and
 *  the publisher's web-version preview both build from this, so the preview is the page. */
export function webVersion(
  html: string,
  opts: {
    config: Config;
    identity: ReaderIdentity;
    /** The date the masthead carries: when the post went out, or will. */
    dateMs: number;
    /** The post's public archive page (`publicViewInBrowserUrl`). */
    viewInBrowserUrl: string;
    devDashboardUrl?: string;
  },
): string {
  const masthead = archiveMasthead({
    name: opts.identity.name,
    dateLabel: formatSentDate(opts.dateMs),
    // Back to the archive index the post belongs to, on the same (archive) origin —
    // so an apex-hosted post stays on the apex instead of jumping to the app subdomain.
    indexUrl: archiveHomeUrl(opts.config),
  });
  const dev = archiveDevDashboardChrome(opts.devDashboardUrl);
  const page = fillSendTokens(
    omitEmailOnly(html),
    { ".Email.ViewInBrowserURL": opts.viewInBrowserUrl },
    "html",
  );
  // Same delivery resolver as a real send, one phase later — then swap the inert anchors.
  return fillDeliveryTokens(
    page,
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
  const send = post ? await latestSentSendForPost(c.env.DB, post.id) : null;
  if (!post || !send) {
    return htmlPage(
      "Not found",
      `<h1 style="margin-top:0;">Not found</h1><p>This post isn't available.</p>`,
      404,
      devDashboardUrl(c.config),
    );
  }
  const html = webVersion(send.rendered_html, {
    config: c.config,
    identity: await readerIdentity(c, c.config),
    dateMs: send.completed_at ?? send.fire_at,
    viewInBrowserUrl: publicViewInBrowserUrl(c.config, post.slug),
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
