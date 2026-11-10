/** Markdown → email-safe HTML, with image references resolved at render time. */
import { Marked, type Token } from "marked";
import type { ImageRow } from "../db/images";
import { escapeHtmlAttr } from "../lib/html";
import { resolveImageSrc } from "./image_urls";

export interface MarkdownContext {
  images: Map<string, ImageRow>;
  mediaBase: string;
  maxWidth: number;
  /** Warnings about the post's images and links are pushed here (surfaced at preview). The
   *  HTML is the same with or without them. */
  warnings: string[];
}

/**
 * Text that reads as an image reference. An image Markdown did parse is its own token and
 * never reaches this, nor does a code span or an escaped `\!`, so what matches is a reference
 * the reader would see typed out. It needs no closing parenthesis, since an address in a
 * broken reference ends the text token the check reads.
 */
const UNPARSED_IMAGE = /!\[.*?\]\([^)\n]*\)?/g;

/**
 * Text that reads as a link. A link Markdown did parse is its own token, so what matches is
 * one the reader would see typed out, most often for a space in its address or a parenthesis
 * that doesn't pair. Like the image check, it needs no address or closing parenthesis: an
 * address in a broken link is linked on its own, which ends the text token at `[a](`.
 */
const UNPARSED_LINK = /\[[^\]\n]*\]\([^)\n]*\)?/g;

export function markdownToHtml(md: string, ctx: MarkdownContext): string {
  const m = new Marked({ gfm: true, breaks: false });
  const referenced = new Set<ImageRow>();
  // The token the walk reached before this one, which is all an escaped `\!` leaves behind.
  let previous: Token | undefined;
  m.use({
    walkTokens(token) {
      const before = previous;
      previous = token;
      // A list item's text carries inline tokens of its own, read as the walk reaches them.
      if (token.type !== "text" || "tokens" in token) {
        return;
      }
      const images: [number, number][] = [];
      for (const match of token.raw.matchAll(UNPARSED_IMAGE)) {
        images.push([match.index, match.index + match[0].length]);
        ctx.warnings.push(
          `“${match[0]}” won’t show as an image, so readers will see it as typed. Check it for a space or a stray bracket, and reference an uploaded image by its file name.`,
        );
      }
      // An image reference warns once, as an image. One whose `!` is escaped is shown as typed
      // on purpose, and reaches here as text starting with the rest of it.
      const escapedImage = before?.type === "escape" && before.raw === "\\!";
      for (const match of token.raw.matchAll(UNPARSED_LINK)) {
        const inImage = images.some(([start, end]) => match.index > start && match.index < end);
        if (inImage || (escapedImage && match.index === 0)) {
          continue;
        }
        ctx.warnings.push(
          `“${match[0]}” won’t show as a link, so readers will see it as typed. Check it for a space or a stray parenthesis.`,
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
        if (image) {
          referenced.add(image);
        }
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
  for (const image of ctx.images.values()) {
    // Raw HTML and a link reach an image by its address without passing the image renderer, and
    // what they write may be percent-encoded, HTML-escaped, or both.
    const address = `${ctx.mediaBase}/${image.storage_key}`;
    const written = [address, encodeURI(address)].flatMap((a) => [a, escapeHtmlAttr(a)]);
    if (!referenced.has(image) && !written.some((a) => html.includes(a))) {
      ctx.warnings.push(`The uploaded image “${image.filename}” isn’t used in this post.`);
    }
  }
  return html;
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
