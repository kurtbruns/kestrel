/**
 * THE single render path. preview, test, schedule and send all call this (I5),
 * so a clean test proves the real send. Deterministic: same input → same bytes.
 * The output carries the delivery-phase sentinels verbatim (the frozen placeholders
 * for the per-recipient unsubscribe URL and sent-to address); consumers fill them at
 * delivery via `substituteRecipient` (send/test) or with generic/empty values
 * (preview/archive). Both go through the one token engine (render/template_engine.ts).
 */

import { archivePostUrl } from "../../shared/archive_url";
import { emailLogoHtml } from "../../shared/email_logo";
import type { ImageRow } from "../db/images";
import type { PostRow, RevisionRow } from "../db/posts";
import type { Config } from "../env";
import { buildImageMap } from "./image_urls";
import { markdownToHtml } from "./markdown";
import { sanitizeEmailHtml } from "./sanitize";
import { emailLayout, emailOnlyRegionsWhole } from "./template";
import {
  DEFAULT_EMAIL_TEMPLATE,
  type DeliveryContext,
  defaultBranding,
  type EmailBranding,
  fillDeliveryTokens,
  fillEmailTemplate,
  identityFieldsInUse,
  inlineEmailCss,
  type RenderContext,
  SENTTO_SENTINEL,
  UNSUB_SENTINEL,
  validateEmailTemplate,
} from "./template_engine";
import { htmlToText } from "./text";

export {
  ARCHIVE_HEAD_ANCHOR,
  ARCHIVE_MASTHEAD_ANCHOR,
  archiveMasthead,
  EMAIL_ONLY_CLOSE,
  EMAIL_ONLY_OPEN,
  omitEmailOnly,
} from "./template";
export { SENTTO_SENTINEL, UNSUB_SENTINEL };

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

/** The canonical archive URL of a post under this deployment (the formula lives in shared/). */
export function archiveUrl(
  config: Pick<Config, "archiveOrigin" | "archiveBasePath">,
  slug: string,
): string {
  return archivePostUrl(config.archiveOrigin, config.archiveBasePath, slug);
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

  // The publisher's template is the email's presentation (SPEC §9). It's validated
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

  const context: RenderContext = {
    ".Post.Body": cleanHtml,
    ".Post.Subject": subject,
    ".Publication.Name": branding.name,
    ".Publication.Tagline": branding.tagline,
    ".Publication.LogoURL": branding.logoUrl,
    ".Publication.Logo": emailLogoHtml(branding.logoUrl, branding.name),
    ".Publication.Address": branding.address,
    ".Email.ViewInBrowserURL": viewInBrowserUrl,
  };
  // fillEmailTemplate freezes the delivery-phase tokens (the unsubscribe URL and sent-to
  // address) to their sentinels here; substituteRecipient fills them per recipient. Those
  // sentinels are the only per-recipient edits — everything else is identical bytes (I3).
  const preheader = derivePreheader(contentText);
  // Inline the template's <style> onto elements (mail clients strip <style>); this is
  // the last step, so the frozen bytes are exactly what ships and what the archive
  // serves (I3). Comments (the archive anchors) and the sentinel survive inlining.
  const renderWith = (tpl: string) =>
    inlineEmailCss(emailLayout({ subject, preheader, bodyHtml: fillEmailTemplate(tpl, context) }));
  let html = await renderWith(template);
  // An email-only region the HTML parser rearranged (a region tag inside an attribute,
  // across elements, or around content a table pushed out, possibly the post) would make
  // the archive page drop more than the region or break its markup. The template's text
  // passed validation, so this shows only once parsed: fall back to the default, as for
  // an invalid template, and say so on preview and test.
  if (template !== DEFAULT_EMAIL_TEMPLATE && !emailOnlyRegionsWhole(html)) {
    warnings.push(
      "email template's {{ if .IsEmail }} region doesn't wrap whole elements, using the default — keep each region's {{ if .IsEmail }} and {{ end }} inside the same element, outside any attribute, and not directly inside a <table> or <tr>.",
    );
    template = DEFAULT_EMAIL_TEMPLATE;
    html = await renderWith(template);
  }

  // The text part's footer is fixed, not the template's, but it carries the mailing
  // address exactly when the HTML part does: a set address the template renders (SPEC
  // §9). Keyed on the template in effect, so the two parts of one email never disagree
  // and the re-make guard, which watches the identity fields the template renders,
  // already covers the text part too.
  const address =
    branding.address !== "" && identityFieldsInUse(template).includes("address")
      ? [branding.address]
      : [];
  const text = [
    contentText,
    "",
    "—",
    "Powered by Kestrel",
    `View in browser: ${viewInBrowserUrl}`,
    `Unsubscribe: ${UNSUB_SENTINEL}`,
    ...address,
    "",
  ].join("\n");

  return { subject, html, text, warnings };
}

/** The DELIVERY pass over a rendered email: fill the per-recipient (delivery-phase)
 *  tokens — the unsubscribe URL and the sent-to address — the only edits made after the
 *  render is frozen (I3/I4). Drives both surfaces through the one token engine: the HTML
 *  part escapes per the registry (unsubscribe URL raw, sent-to attribute-safe), the text
 *  part inserts raw. Byte-for-byte a direct sentinel replacement. */
export function substituteRecipient(r: RenderedEmail, ctx: DeliveryContext): RenderedEmail {
  return {
    subject: r.subject,
    html: fillDeliveryTokens(r.html, ctx, "html"),
    text: fillDeliveryTokens(r.text, ctx, "text"),
  };
}
