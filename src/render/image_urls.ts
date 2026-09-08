/** Resolve Markdown image references to absolute, email-safe URLs. */
import type { ImageRow } from "../db/images";

export function buildImageMap(images: ImageRow[]): Map<string, ImageRow> {
  const map = new Map<string, ImageRow>();
  for (const img of images) map.set(img.filename, img);
  return map;
}

export interface ResolvedImage {
  url: string;
  image: ImageRow | null;
}

/**
 * `cover.jpg` → `${mediaBase}/posts/{id}/cover.jpg`. Already-absolute or
 * data:/cid: URLs pass through untouched; an unknown reference is left as-is
 * (the caller records a warning via missing-alt / preview review).
 */
export function resolveImageSrc(
  href: string,
  images: Map<string, ImageRow>,
  mediaBase: string,
): ResolvedImage {
  if (/^https?:\/\//i.test(href) || href.startsWith("data:") || href.startsWith("cid:")) {
    return { url: href, image: null };
  }
  const name = href.split("/").pop() ?? href;
  const image = images.get(name) ?? images.get(href) ?? null;
  if (image) return { url: `${mediaBase}/${image.storage_key}`, image };
  return { url: href, image: null };
}
