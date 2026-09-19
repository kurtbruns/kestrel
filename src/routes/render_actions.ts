/**
 * Preview, test-send, and the fake outbox. All authed.
 *   POST /posts/:id/preview        → { url, subject, warnings } (hosted view-in-browser)
 *   GET  /posts/:id/preview        → the rendered HTML (generic unsubscribe link)
 *   POST /posts/:id/test           → send the real render to one address via the provider
 *                                    (a scheduled post's frozen copy; a draft's live render)
 *   POST /api/settings/template/test → send a SAMPLE post through the saved template
 *   GET  /api/dev/outbox           → fake transport's outbox (fake provider only)
 *
 * Every path runs the one render() (I5).
 */

import * as images from "../db/images";
import type { PostRow, RevisionRow } from "../db/posts";
import * as posts from "../db/posts";
import { getActiveSendForPost } from "../db/sends";
import { getSettings } from "../db/settings";
import { isValidEmail, normalizeEmail } from "../db/subscribers";
import { badRequest, json, notFound } from "../lib/errors";
import { getProvider } from "../providers";
import { fakeOutbox } from "../providers/fake";
import {
  type RenderedEmail,
  type RenderInput,
  render,
  substituteRecipient,
} from "../render/render";
import { type EmailBranding, resolveBranding } from "../render/template_engine";
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

/** The branding (template + identity) the render path fills — the same the send uses. */
async function loadBranding(c: RequestContext): Promise<EmailBranding> {
  return resolveBranding(await getSettings(c.env.DB), c.config);
}

/** The email a post's publisher-facing instruments show or send (SPEC §5): once the
 *  post is scheduled, the active send's frozen copy — exactly what will fire, or is
 *  firing (a send in flight is still the frozen copy readers are receiving); before
 *  that, a live render of the current draft through the one render path (I5). One
 *  reader for the preview page, the preview action, and the post test, so the three
 *  instruments can never disagree about what is going out. */
interface PostEmail {
  input: RenderInput;
  email: RenderedEmail;
  warnings: string[];
  /** The active send whose frozen copy this is; null for a draft's live render. */
  frozen: { id: string } | null;
}

async function loadPostEmail(c: RequestContext): Promise<PostEmail> {
  const input = await loadRenderInput(c);
  const active =
    input.post.status === "scheduled" ? await getActiveSendForPost(c.env.DB, input.post.id) : null;
  if (active) {
    return {
      input,
      email: { subject: active.subject, html: active.rendered_html, text: active.rendered_text },
      warnings: [],
      frozen: { id: active.id },
    };
  }
  const result = await render(input, c.config, await loadBranding(c));
  return { input, email: result, warnings: result.warnings, frozen: null };
}

export async function preview(c: RequestContext): Promise<Response> {
  const { input, email, warnings, frozen } = await loadPostEmail(c);
  return json({
    url: `${c.config.appOrigin}/posts/${input.post.id}/preview`,
    subject: email.subject,
    warnings,
    frozen: frozen !== null,
  });
}

export async function previewPage(c: RequestContext): Promise<Response> {
  const { email } = await loadPostEmail(c);
  const html = substituteRecipient(email, {
    "email.unsubscribeUrl": genericUnsubscribeUrl(c),
    "email.sentTo": "",
  }).html;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

/**
 * Send a post test to one address. Once the post is scheduled, the test is its
 * FROZEN copy (SPEC §5): the send's `rendered_html`/`rendered_text`, handed to the
 * provider exactly as the fire path hands them, with the per-recipient placeholders
 * filled for the test address — so a template or identity change made after
 * scheduling can never make the test disagree with what will go out (or with the
 * view-in-browser page). A draft keeps the live render: its content, the current
 * template, and the current identity, through the one render path (I5).
 */
export async function test(c: RequestContext): Promise<Response> {
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

  const { input, email, warnings, frozen } = await loadPostEmail(c);
  const provider = getProvider(c.config, c.env);
  // A test uses the same per-recipient substitution path as a real send.
  const unsubscribeUrl = `${c.config.appOrigin}/unsubscribe?test=1`;
  const [res] = await provider.sendBatch(email, [{ email: to, unsubscribeUrl }], {
    idempotencyKeyPrefix: `test-${input.post.id}`,
  });

  return json({
    sent: res?.accepted === true,
    provider: provider.name,
    to,
    subject: email.subject,
    warnings,
    // Which copy went: the scheduled send's frozen render (and which send), or the
    // draft's live render.
    frozen: frozen !== null,
    send_id: frozen?.id ?? null,
  });
}

// --- template test-send ----------------------------------------------------------

/** How many addresses one template test may fan out to (matches the settings cap). */
const MAX_TEMPLATE_TEST_RECIPIENTS = 20;

// A synthetic post that stands in for {{ post.body }} when testing the TEMPLATE
// itself — there's no real post to render, so this sample supplies one. It flows
// through the same render() as a real send (I5); only the body's source differs.
// The prose mirrors the on-page sample preview so the inbox test matches what the
// editor showed.
const TEMPLATE_TEST_SUBJECT = "Template test — the starlings are back";
const TEMPLATE_TEST_MARKDOWN = [
  "# The starlings are back",
  "",
  "A cold front slid off the lake overnight, and with it the first big roost of the season — a few thousand birds turning over the water at dusk.",
  "",
  "Three things I noticed this week, and one question for you.",
  "",
  "- The light is going gold a full hour earlier.",
  "- The maples on Marsh Lane have finally turned.",
  "- Someone left a note in the little free library, addressed to no one.",
  "",
  "This is a **sample post** sent to preview your email template — [links](https://example.com) render like this. A real post's Markdown fills this space.",
].join("\n");

/** Build the synthetic render input for a template test — no post, no images. */
function sampleRenderInput(): RenderInput {
  const now = Date.now();
  const post: PostRow = {
    id: "sample",
    slug: "sample-post",
    subject: TEMPLATE_TEST_SUBJECT,
    status: "draft",
    current_revision: "sample-rev",
    created_at: now,
    updated_at: now,
  };
  const revision: RevisionRow = {
    id: "sample-rev",
    post_id: "sample",
    markdown: TEMPLATE_TEST_MARKDOWN,
    metadata: JSON.stringify({ subject: TEMPLATE_TEST_SUBJECT, slug: post.slug }),
    author: null,
    created_at: now,
  };
  return { post, revision, images: [] };
}

/** Resolve the recipient list: the body's `to` (a string or array), or — when it's
 *  omitted — the saved default test recipients. Normalizes, validates, and dedupes;
 *  throws a 400 that names a bad address. */
function resolveTestRecipients(body: unknown, defaults: string[]): string[] {
  const raw = (body as { to?: unknown } | null)?.to;
  let input: unknown[];
  if (raw === undefined || raw === null) {
    input = defaults;
  } else if (Array.isArray(raw)) {
    input = raw;
  } else {
    input = [raw];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      throw badRequest("each recipient must be an email address");
    }
    const email = normalizeEmail(item);
    if (!email) {
      continue;
    }
    if (!isValidEmail(email)) {
      throw badRequest(`not a valid email address: ${item}`);
    }
    if (seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Send a test of the EMAIL TEMPLATE: render a sample post through the one render
 * path with the *saved* branding (template + identity) and deliver it via the
 * provider, so the operator sees the template in a real inbox (SPEC §5, I5). It
 * renders what will actually ship — the stored template, never unsaved editor
 * content — so a clean test is a real guarantee, not a lookalike.
 */
export async function templateTest(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // An empty/absent body is fine — fall back to the saved default recipients.
  }
  const recipients = resolveTestRecipients(body, settings.testRecipients);
  if (recipients.length === 0) {
    throw badRequest(
      "no recipients — pass a 'to' address, or set default test recipients in Settings",
    );
  }
  if (recipients.length > MAX_TEMPLATE_TEST_RECIPIENTS) {
    throw badRequest(`at most ${MAX_TEMPLATE_TEST_RECIPIENTS} recipients per test`);
  }

  const result = await render(sampleRenderInput(), c.config, resolveBranding(settings, c.config));
  const provider = getProvider(c.config, c.env);
  const unsubscribeUrl = `${c.config.appOrigin}/unsubscribe?test=1`;
  // A deliberate manual test is a fresh send each press (not a retry), so the
  // idempotency key is unique per request — an idempotent provider won't fold two
  // intentional tests into one.
  const results = await provider.sendBatch(
    result,
    recipients.map((email) => ({ email, unsubscribeUrl })),
    { idempotencyKeyPrefix: `template-test-${Date.now()}` },
  );
  const sent = results.filter((r) => r.accepted).length;

  return json({
    sent,
    total: recipients.length,
    provider: provider.name,
    recipients,
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
