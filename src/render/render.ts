/**
 * THE single render path. preview, test, schedule and send all call this (I5),
 * so a clean test proves the real send. Deterministic: same input → same bytes.
 * The output carries the %%UNSUBSCRIBE_URL%% sentinel verbatim; consumers
 * substitute it per-recipient (send/test) or with a generic link (preview/archive).
 */
import type { Config } from "../env";
import type { PostRow, RevisionRow } from "../db/posts";
import type { ImageRow } from "../db/images";
import { markdownToHtml } from "./markdown";
import { sanitizeEmailHtml } from "./sanitize";
import { buildImageMap } from "./image_urls";
import { emailLayout, UNSUB_SENTINEL } from "./template";
import { htmlToText } from "./text";

export { UNSUB_SENTINEL };

/** Widest image column an email client will show for our 600px layout. */
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
  title: string;
  subject: string;
  preheader: string;
  slug: string;
}

function readMeta(revision: RevisionRow, post: PostRow): RevisionMeta {
  try {
    const m = JSON.parse(revision.metadata) as Partial<RevisionMeta>;
    return {
      title: m.title ?? post.title,
      subject: m.subject ?? post.subject,
      preheader: m.preheader ?? post.preheader,
      slug: m.slug ?? post.slug,
    };
  } catch {
    return { title: post.title, subject: post.subject, preheader: post.preheader, slug: post.slug };
  }
}

export function archiveUrl(config: Config, slug: string): string {
  return `${config.archiveOrigin}${config.archiveBasePath}/${slug}`;
}

export function render(input: RenderInput, config: Config): RenderResult {
  const meta = readMeta(input.revision, input.post);
  const warnings: string[] = [];

  const contentHtml = markdownToHtml(input.revision.markdown, {
    images: buildImageMap(input.images ?? []),
    mediaBase: config.mediaPublicBase,
    maxWidth: EMAIL_MAX_WIDTH,
    warnings,
  });
  const cleanHtml = sanitizeEmailHtml(contentHtml);
  const subject = meta.subject || meta.title || "(no subject)";
  const viewInBrowserUrl = archiveUrl(config, meta.slug);

  const html = emailLayout({
    subject,
    preheader: meta.preheader,
    contentHtml: cleanHtml,
    viewInBrowserUrl,
  });

  const text = [
    htmlToText(cleanHtml),
    "",
    "—",
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
