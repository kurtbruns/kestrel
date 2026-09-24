/**
 * The image formats the app accepts, one allowlist for post images and the logo so the
 * two can't drift apart. Raster only: what mail clients show, and none that runs. Every
 * upload is served back publicly, and a media custom domain serves the bytes without the
 * `/media` route's sandbox headers, so an SVG (or HTML) would run as a live page there.
 */

/** The raster formats an uploaded image may be. */
export const RASTER_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** A declared content type as its bare media type: `Image/PNG; x=y` is `image/png`. */
export function mediaType(declared: string): string {
  return (declared.split(";")[0] ?? "").trim().toLowerCase() || "application/octet-stream";
}
