/** Resolve Markdown image references to absolute, email-safe URLs. */
import type { ImageRow } from "../db/images";

export function buildImageMap(images: ImageRow[]): Map<string, ImageRow> {
  const map = new Map<string, ImageRow>();
  for (const img of images) {
    map.set(img.filename, img);
  }
  return map;
}

export interface ResolvedImage {
  url: string;
  image: ImageRow | null;
  /** The reference was a full URL under this instance's own media base, not a name. */
  ownMedia: boolean;
}

/**
 * `cover.jpg` → `${mediaBase}/posts/{id}/cover.jpg`. A full URL under this
 * instance's media base is matched against the post's own images by storage key,
 * so a deleted image or another post's is caught rather than passed through (the
 * caller warns on both). Other absolute and data:/cid: URLs pass through untouched;
 * an unknown name is left as-is for the caller to warn on.
 */
export function resolveImageSrc(
  href: string,
  images: Map<string, ImageRow>,
  mediaBase: string,
): ResolvedImage {
  const key = ownMediaKey(href, mediaBase);
  if (key !== null) {
    const image = [...images.values()].find((img) => img.storage_key === key) ?? null;
    return { url: image ? `${mediaBase}/${image.storage_key}` : href, image, ownMedia: true };
  }
  if (/^https?:\/\//i.test(href) || href.startsWith("data:") || href.startsWith("cid:")) {
    return { url: href, image: null, ownMedia: false };
  }
  const name = href.split("/").pop() ?? href;
  const image = images.get(name) ?? images.get(href) ?? null;
  if (image) {
    return { url: `${mediaBase}/${image.storage_key}`, image, ownMedia: false };
  }
  return { url: href, image: null, ownMedia: false };
}

/** The storage key a full URL names under the media base, or null for any other reference. */
function ownMediaKey(href: string, mediaBase: string): string | null {
  if (!/^https?:\/\//i.test(href)) {
    return null;
  }
  let ref: URL;
  let base: URL;
  try {
    ref = new URL(href);
    base = new URL(mediaBase);
  } catch {
    return null;
  }
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (ref.origin !== base.origin || !ref.pathname.startsWith(prefix)) {
    return null;
  }
  const rest = ref.pathname.slice(prefix.length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
