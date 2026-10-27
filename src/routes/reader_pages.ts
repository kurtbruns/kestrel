/**
 * Settings' previews of the reader pages (SPEC §5): every page and state a reader can land
 * on, rendered by the code that serves the real page, with the publication's saved
 * identity and sample values in place of a reader's, and nothing else: the frame Settings
 * holds it in says it is a preview, so the page is exactly a reader's. Authed, and never a
 * public page (§11): a preview shows, it never acts.
 *   GET /api/reader-pages/:journey/:state → the page as a standalone HTML document
 */

import { findReaderPage } from "../../shared/reader_pages";
import { getSettings } from "../db/settings";
import { notFound } from "../lib/errors";
import { archiveIndexPage, landingPage } from "../lib/page";
import { POST_PAGE_SECURITY_HEADERS } from "../lib/page_headers";
import { archiveUrl, render } from "../render/render";
import { resolveBranding } from "../render/template_engine";
import type { RequestContext } from "../router";
import { param } from "../router";
import { formatPublishedDate, nothingHereYetPage, webVersion } from "./archive";
import {
  confirmStatePage,
  signupsOpen,
  subscribeCheckInboxPage,
  subscribeFormPage,
  subscribeNotAnEmailPage,
  unsubscribeAskPage,
  unsubscribedPage,
  unsubscribeInvalidPage,
} from "./public";
import { archiveHomeUrl, readerIdentity } from "./reader";
import { SAMPLE_POST_SUBJECT, sampleRenderInput } from "./render_actions";

/** The address a preview shows where a reader's own would be. */
const SAMPLE_EMAIL = "reader@example.com";

const DAY_MS = 86_400_000;

/** The archive as a preview lists it: the sample post (the one the post page shows),
 *  then two older ones. */
function samplePosts(c: RequestContext, now: number) {
  return [
    { title: SAMPLE_POST_SUBJECT, slug: "sample-post", at: now },
    { title: "Notes from the first frost", slug: "first-frost", at: now - 7 * DAY_MS },
    { title: "What the river kept", slug: "what-the-river-kept", at: now - 14 * DAY_MS },
  ].map((p) => ({
    title: p.title,
    url: archiveUrl(c.config, p.slug),
    dateLabel: formatPublishedDate(p.at),
  }));
}

/** One page, as its route would answer, with sample values. */
async function previewOf(c: RequestContext, journey: string, state: string): Promise<Response> {
  const home = `${c.config.appOrigin}/`;
  const subscribeUrl = `${c.config.appOrigin}/subscribe`;
  const sample = { email: SAMPLE_EMAIL };
  switch (`${journey}/${state}`) {
    case "subscribe/form":
      return subscribeFormPage(c, await readerIdentity(c, c.config));
    case "subscribe/check-inbox":
      return subscribeCheckInboxPage(c, await readerIdentity(c, c.config));
    case "subscribe/not-an-email":
      return subscribeNotAnEmailPage(c, await readerIdentity(c, c.config));
    case "confirm/ready":
      return confirmStatePage(c, { kind: "ready", subscriber: sample }, "");
    case "confirm/confirmed":
      return confirmStatePage(c, { kind: "confirmed", subscriber: sample }, "");
    case "confirm/expired":
      return confirmStatePage(c, { kind: "expired", subscriber: sample }, "");
    case "confirm/invalid":
      return confirmStatePage(c, { kind: "invalid" }, "");
    case "unsubscribe/ask":
      return unsubscribeAskPage(c, SAMPLE_EMAIL, "/unsubscribe");
    case "unsubscribe/done":
      return unsubscribedPage(c, SAMPLE_EMAIL);
    case "unsubscribe/invalid":
      return unsubscribeInvalidPage(c);
    case "reading/landing": {
      const [featured, ...recent] = samplePosts(c, Date.now());
      return landingPage({
        identity: await readerIdentity(c, c.config),
        subscribeUrl,
        homeUrl: home,
        archiveUrl: archiveHomeUrl(c.config),
        featured,
        recent,
        signupsOpen: signupsOpen(c.config),
      });
    }
    case "reading/archive":
      return archiveIndexPage({
        identity: await readerIdentity(c, c.config),
        subscribeUrl,
        homeUrl: home,
        posts: samplePosts(c, Date.now()),
      });
    // The same two pages before the first post is sent.
    case "reading/landing-empty":
      return landingPage({
        identity: await readerIdentity(c, c.config),
        subscribeUrl,
        homeUrl: home,
        archiveUrl: archiveHomeUrl(c.config),
        recent: [],
        signupsOpen: signupsOpen(c.config),
      });
    case "reading/archive-empty":
      return archiveIndexPage({
        identity: await readerIdentity(c, c.config),
        subscribeUrl,
        homeUrl: home,
        posts: [],
      });
    case "reading/post": {
      // The sample post through the one render path and the saved template (I5), then
      // the post page's own code, as a template test renders it.
      const settings = await getSettings(c.env.DB);
      const email = await render(
        sampleRenderInput(SAMPLE_POST_SUBJECT),
        c.config,
        resolveBranding(settings, c.config),
      );
      const html = webVersion(email.html, {
        config: c.config,
        identity: await readerIdentity(c, c.config),
        dateMs: Date.now(),
      });
      return new Response(html);
    }
    case "reading/not-found":
      return nothingHereYetPage(c);
  }
  throw notFound("reader page");
}

/** A reader page's preview. It answers 200 whatever status the real page carries (an
 *  expired link's 410, say): the preview itself succeeded. Its forms submit nowhere, even
 *  opened in a tab of its own: the expired page's would otherwise ask for a link to the
 *  sample address. */
export async function readerPagePreview(c: RequestContext): Promise<Response> {
  const journey = param(c, "journey");
  const state = param(c, "state");
  if (!findReaderPage(journey, state)) {
    throw notFound("reader page");
  }
  // A preview is the page a deployed reader gets, so it leaves out local dev's
  // dashboard shortcut.
  const pc: RequestContext = { ...c, config: { ...c.config, devMode: false } };
  const page = await previewOf(pc, journey, state);
  return new Response(page.body, {
    headers: {
      ...POST_PAGE_SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
