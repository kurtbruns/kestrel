/**
 * Preview, test-send, and the fake outbox. All authed.
 *   POST /posts/:id/preview  → { url, subject, warnings } (hosted view-in-browser)
 *   GET  /posts/:id/preview  → the rendered HTML (generic unsubscribe link)
 *   POST /posts/:id/test     → send the real render to one address via the provider
 *   GET  /api/dev/outbox     → fake transport's outbox (fake provider only)
 *
 * Every path runs the one render() (I5).
 */

import * as images from "../db/images";
import * as posts from "../db/posts";
import { badRequest, json, notFound } from "../lib/errors";
import { getProvider } from "../providers";
import { fakeOutbox } from "../providers/fake";
import { type RenderInput, render, substituteUnsubscribe } from "../render/render";
import type { RequestContext } from "../router";
import { param } from "../router";

async function loadRenderInput(c: RequestContext): Promise<RenderInput> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const revision = await posts.getCurrentRevision(c.env.DB, post);
  if (!revision) {
    throw badRequest("post has no content yet");
  }
  const imgs = await images.listImages(c.env.DB, post.id);
  return { post, revision, images: imgs };
}

/** Generic (non-tokened) unsubscribe link used in preview + archive. */
function genericUnsubscribeUrl(c: RequestContext): string {
  return `${c.config.appOrigin}/unsubscribe`;
}

export async function preview(c: RequestContext): Promise<Response> {
  const input = await loadRenderInput(c);
  const result = render(input, c.config);
  return json({
    url: `${c.config.appOrigin}/posts/${input.post.id}/preview`,
    subject: result.subject,
    warnings: result.warnings,
  });
}

export async function previewPage(c: RequestContext): Promise<Response> {
  const input = await loadRenderInput(c);
  const result = render(input, c.config);
  const html = substituteUnsubscribe(result, genericUnsubscribeUrl(c)).html;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

export async function test(c: RequestContext): Promise<Response> {
  const input = await loadRenderInput(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("JSON body with a 'to' address is required");
  }
  const to =
    typeof (body as { to?: unknown })?.to === "string" ? (body as { to: string }).to.trim() : "";
  if (!to.includes("@")) {
    throw badRequest("'to' must be an email address");
  }

  const result = render(input, c.config);
  const provider = getProvider(c.config, c.env);
  // A test uses the same per-recipient substitution path as a real send.
  const unsubscribeUrl = `${c.config.appOrigin}/unsubscribe?test=1`;
  const [res] = await provider.sendBatch(result, [{ email: to, unsubscribeUrl }], {
    idempotencyKeyPrefix: `test-${input.post.id}`,
  });

  return json({
    sent: res?.accepted === true,
    provider: provider.name,
    to,
    subject: result.subject,
    warnings: result.warnings,
  });
}

export async function devOutbox(c: RequestContext): Promise<Response> {
  if (c.config.provider !== "fake") {
    throw notFound("not available for this transport");
  }
  return json({ messages: fakeOutbox() });
}
