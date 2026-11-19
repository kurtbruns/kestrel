/**
 * Markdown → email-safe HTML, with image references resolved at render time, and the one
 * answer to which of a post's uploaded images its body uses (`imagesUsedBy`), which the
 * preview's warning and the send's removal of unused images both read (SPEC §4).
 */
import { Marked, type MarkedExtension } from "marked";
import type { ImageRow } from "../db/images";
import { escapeHtmlAttr } from "../lib/html";
import { resolveImageSrc } from "./image_urls";

/** How every post's Markdown is read, so the render and `imagesUsedBy` see the same tokens. */
const MARKED_OPTIONS: MarkedExtension = { gfm: true, breaks: false };

export interface MarkdownContext {
  images: Map<string, ImageRow>;
  mediaBase: string;
  maxWidth: number;
  /** Warnings about the post's images are pushed here (surfaced at preview). The HTML is the
   *  same with or without them. */
  warnings: string[];
}

/**
 * Text that reads as an image reference. An image Markdown did parse is its own token and
 * never reaches this, nor does a code span or an escaped `\!`, so what matches is a reference
 * the reader would see typed out. It needs no closing parenthesis, since an address in a
 * broken reference ends the text token the check reads.
 */
const UNPARSED_IMAGE = /!\[.*?\]\([^)\n]*\)?/g;

export function markdownToHtml(md: string, ctx: MarkdownContext): string {
  const m = new Marked(MARKED_OPTIONS);
  m.use({
    walkTokens(token) {
      // A list item's text carries inline tokens of its own, read as the walk reaches them.
      if (token.type !== "text" || "tokens" in token) {
        return;
      }
      for (const [written] of token.raw.matchAll(UNPARSED_IMAGE)) {
        ctx.warnings.push(
          `“${written}” won’t show as an image, so readers will see it as typed. Check it for a space or a stray bracket, and reference an uploaded image by its file name.`,
        );
      }
    },
    renderer: {
      image(token) {
        const href = token.href ?? "";
        const alt = token.text ?? "";
        if (!alt.trim()) {
          ctx.warnings.push(
            `The image “${href}” has no alt text. Describe it between the square brackets.`,
          );
        }
        const { url, image, ownMedia } = resolveImageSrc(href, ctx.images, ctx.mediaBase);
        if (image && ownMedia) {
          ctx.warnings.push(
            `The image “${href}” should be referenced as “${image.filename}”. Use its file name, not its address.`,
          );
        } else if (!image && ownMedia) {
          ctx.warnings.push(
            `The image “${href}” isn’t on this post. Upload it to this post and reference it by its file name.`,
          );
        } else if (!image && !/^https?:\/\//i.test(url)) {
          ctx.warnings.push(
            `The image “${href}” isn’t on this post. Upload it, or check the file name.`,
          );
        }
        const size = sizeAttrs(image?.width ?? null, image?.height ?? null, ctx.maxWidth);
        const title = token.title ? ` title="${escapeHtmlAttr(token.title)}"` : "";
        return `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(alt)}"${title}${size} style="max-width:100%;height:auto;border:0;display:block;" />`;
      },
    },
  });
  const html = m.parse(md) as string;
  const used = imagesUsedBy(md, ctx.images, ctx.mediaBase);
  for (const image of ctx.images.values()) {
    if (!used.has(image)) {
      ctx.warnings.push(unusedImageWarning(image.filename));
    }
  }
  return html;
}

/** The preview's word on an image the body doesn't use, which the send then deletes. */
export function unusedImageWarning(filename: string): string {
  return `The uploaded image “${filename}” isn’t used in this post, so it’s deleted when the post sends.`;
}

/**
 * The post's uploaded images its body uses, read from the Markdown as marked parses it
 * (SPEC §4): an image a Markdown image resolves to, by name or by address; one a link's
 * address names; and one whose storage key raw HTML in the body names. At send this runs on
 * the locked revision, the one the email was frozen from, and every image it leaves out is
 * deleted, so each test errs toward keeping. An address names an image by its path alone,
 * whatever the host, so a media base changed since the email was frozen, or `/media` on the
 * app's origin, still counts. The email template is not the body: an image only it uses is
 * use outside the post, which is unsupported.
 */
export function imagesUsedBy(
  md: string,
  images: Map<string, ImageRow>,
  mediaBase: string,
): Set<ImageRow> {
  const used = new Set<ImageRow>();
  if (images.size === 0) {
    return used;
  }
  const all = [...images.values()];
  const m = new Marked(MARKED_OPTIONS);
  m.walkTokens(m.lexer(md), (token) => {
    if (token.type === "image" || token.type === "link") {
      const href: string = token.href ?? "";
      if (token.type === "image") {
        const { image } = resolveImageSrc(href, images, mediaBase);
        if (image) {
          used.add(image);
        }
      }
      for (const image of all) {
        if (addressNames(href, image.storage_key)) {
          used.add(image);
        }
      }
    } else if (token.type === "html") {
      for (const image of all) {
        if (htmlNames(token.raw, image.storage_key)) {
          used.add(image);
        }
      }
    }
  });
  return used;
}

/** Whether an address's path, before any query or fragment and decoded, ends with the key. */
function addressNames(href: string, key: string): boolean {
  const path = decodePercent(href.split(/[?#]/)[0] ?? "");
  return path === key || path.endsWith(`/${key}`);
}

/** Whether raw HTML names the key: as written, with `&` escaped, percent-encoded, or both. */
function htmlNames(raw: string, key: string): boolean {
  const unescaped = raw.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
  return [raw, unescaped, decodePercent(unescaped)].some((text) => text.includes(key));
}

/** Decode each run of percent-escapes on its own, leaving one that isn't valid UTF-8 as written,
 *  so a stray `%` elsewhere never stops the rest from decoding. */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Constrain declared dimensions to the email column width (byte-resizing deferred). */
function sizeAttrs(w: number | null, h: number | null, maxWidth: number): string {
  if (!w || !h) {
    return "";
  }
  let width = w;
  let height = h;
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  return ` width="${width}" height="${height}"`;
}
