/**
 * THE single render path. preview, test, schedule and send all call this (I5),
 * so a clean test proves the real send. Deterministic: same input → same bytes.
 * The output carries the %%UNSUBSCRIBE_URL%% sentinel verbatim; consumers
 * substitute it per-recipient (send/test) or with a generic link (preview/archive).
 */

import type { ImageRow } from "../db/images";
import type { PostRow, RevisionRow } from "../db/posts";
import type { Config } from "../env";
import { buildImageMap } from "./image_urls";
import { markdownToHtml } from "./markdown";
import { sanitizeEmailHtml } from "./sanitize";
import { emailLayout, UNSUB_SENTINEL } from "./template";
import {
  DEFAULT_EMAIL_TEMPLATE,
  defaultBranding,
  type EmailBranding,
  fillEmailTemplate,
  inlineEmailCss,
  type TemplateContext,
  validateEmailTemplate,
} from "./template_engine";
import { htmlToText } from "./text";

export { ARCHIVE_HEAD_ANCHOR, ARCHIVE_MASTHEAD_ANCHOR, archiveMasthead } from "./template";
export { UNSUB_SENTINEL };

/** Widest image column an email client will show for our 600px content column. */
const EMAIL_MAX_WIDTH = 600;

export interface RenderInput {
  post: PostRow;
  revision: RevisionRow;
  images: ImageRow[];
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderResult extends RenderedEmail {
  warnings: string[];
}

interface RevisionMeta {
  subject: string;
  slug: string;
}

function readMeta(revision: RevisionRow, post: PostRow): RevisionMeta {
  try {
    const m = JSON.parse(revision.metadata) as Partial<RevisionMeta>;
    return { subject: m.subject ?? post.subject, slug: m.slug ?? post.slug };
  } catch {
    return { subject: post.subject, slug: post.slug };
  }
}

/** Inbox preview text, derived from the start of the body (no manual field). */
function derivePreheader(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, 140);
}

export function archiveUrl(config: Config, slug: string): string {
  return `${config.archiveOrigin}${config.archiveBasePath}/${slug}`;
}

export async function render(
  input: RenderInput,
  config: Config,
  branding: EmailBranding = defaultBranding(),
): Promise<RenderResult> {
  const meta = readMeta(input.revision, input.post);
  const warnings: string[] = [];

  const contentHtml = markdownToHtml(input.revision.markdown, {
    images: buildImageMap(input.images ?? []),
    mediaBase: config.mediaPublicBase,
    maxWidth: EMAIL_MAX_WIDTH,
    warnings,
  });
  const cleanHtml = sanitizeEmailHtml(contentHtml);
  const contentText = htmlToText(cleanHtml);
  // Whitespace-only reads as no subject too, so warn and fall back on the trimmed
  // value — keeping the warning honest and the placeholder shown for either case.
  const hasSubject = meta.subject.trim() !== "";
  if (!hasSubject) {
    warnings.push('no subject — the email will show "(no subject)"');
  }
  const subject = hasSubject ? meta.subject : "(no subject)";
  const viewInBrowserUrl = archiveUrl(config, meta.slug);

  // The publisher's template is the email's presentation (SPEC §8). It's validated
  // when it's set; here we surface its warnings on preview/test and, as defense in
  // depth, fall back to the built-in default if the active template is somehow
  // invalid — a broken or unsubscribe-less email must never ship (I2).
  const validation = validateEmailTemplate(branding.template);
  let template = branding.template;
  if (validation.errors.length > 0) {
    warnings.push(`email template invalid, using the default — ${validation.errors.join(" ")}`);
    template = DEFAULT_EMAIL_TEMPLATE;
  } else {
    warnings.push(...validation.warnings);
  }

  const context: TemplateContext = {
    "post.body": cleanHtml,
    "post.subject": subject,
    "publication.name": branding.name,
    "publication.tagline": branding.tagline,
    "publication.logoUrl": branding.logoUrl,
    "publication.address": branding.address,
    // The per-recipient sentinel flows through the template unchanged and is the ONLY
    // per-recipient edit (substituteUnsubscribe); everything else is identical bytes.
    "email.unsubscribeUrl": UNSUB_SENTINEL,
    "email.viewInBrowserUrl": viewInBrowserUrl,
  };
  const body = fillEmailTemplate(template, context);
  const shell = emailLayout({ subject, preheader: derivePreheader(contentText), bodyHtml: body });
  // Inline the template's <style> onto elements (mail clients strip <style>); this is
  // the last step, so the frozen bytes are exactly what ships and what the archive
  // serves (I3). Comments (the archive anchors) and the sentinel survive inlining.
  const html = await inlineEmailCss(shell);

  const text = [
    contentText,
    "",
    "—",
    "Powered by Kestrel",
    `View in browser: ${viewInBrowserUrl}`,
    `Unsubscribe: ${UNSUB_SENTINEL}`,
    "",
  ].join("\n");

  return { subject, html, text, warnings };
}

/** Replace the unsubscribe sentinel in a rendered email. The ONLY per-recipient edit. */
export function substituteUnsubscribe(r: RenderedEmail, unsubscribeUrl: string): RenderedEmail {
  return {
    subject: r.subject,
    html: r.html.split(UNSUB_SENTINEL).join(unsubscribeUrl),
    text: r.text.split(UNSUB_SENTINEL).join(unsubscribeUrl),
  };
}
