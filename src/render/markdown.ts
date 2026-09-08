/** Markdown → email-safe HTML, with image references resolved at render time. */
import { Marked } from "marked";
import type { ImageRow } from "../db/images";
import { escapeHtmlAttr } from "../lib/html";
import { resolveImageSrc } from "./image_urls";

export interface MarkdownContext {
  images: Map<string, ImageRow>;
  mediaBase: string;
  maxWidth: number;
  /** Missing-alt and unresolved-image warnings are pushed here (surfaced at preview). */
  warnings: string[];
}

export function markdownToHtml(md: string, ctx: MarkdownContext): string {
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    renderer: {
      image(token) {
        const href = token.href ?? "";
        const alt = token.text ?? "";
        if (!alt.trim()) ctx.warnings.push(`image "${href}" is missing alt text`);
        const { url, image } = resolveImageSrc(href, ctx.images, ctx.mediaBase);
        if (!image && !/^https?:\/\//i.test(url)) {
          ctx.warnings.push(`image "${href}" was not found on this post`);
        }
        const size = sizeAttrs(image?.width ?? null, image?.height ?? null, ctx.maxWidth);
        const title = token.title ? ` title="${escapeHtmlAttr(token.title)}"` : "";
        return `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(alt)}"${title}${size} style="max-width:100%;height:auto;border:0;display:block;" />`;
      },
    },
  });
  return m.parse(md) as string;
}

/** Constrain declared dimensions to the email column width (byte-resizing deferred). */
function sizeAttrs(w: number | null, h: number | null, maxWidth: number): string {
  if (!w || !h) return "";
  let width = w;
  let height = h;
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  return ` width="${width}" height="${height}"`;
}
