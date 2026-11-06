/**
 * The image formats the app accepts, one allowlist for post images and the logo so the
 * two can't drift apart. Raster only: what mail clients show, and none that runs. Every
 * upload is served back publicly, and a media custom domain serves the bytes without the
 * `/media` route's sandbox headers, so an SVG (or HTML) would run as a live page there.
 *
 * What an upload is comes from its bytes, since whatever is stored here is what a whole list
 * is sent. A name or declared type may say nothing, but one that says something else is
 * refused: it could be the wrong file, and a stored name keeps its claim in a public address.
 */

import { imageTypeOfName } from "../../shared/images";

/** The raster formats an uploaded image may be. */
export const RASTER_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** A declared content type as its bare media type: `Image/PNG; x=y` is `image/png`. */
function mediaType(declared: string): string {
  return (declared.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether `b` holds `signature` at `offset`. */
function holds(b: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => b[offset + i] === byte);
}

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

/**
 * The raster format a file's opening bytes show it to be, or undefined for any other file. It
 * reads the signature, not the whole image, so a truncated or corrupt image of one of these
 * formats still passes: decoding one is more than a Worker should do for an upload.
 */
export function imageTypeOf(b: Uint8Array): string | undefined {
  if (holds(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (holds(b, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (holds(b, ascii("GIF87a")) || holds(b, ascii("GIF89a"))) {
    return "image/gif";
  }
  // RIFF is a container that also holds audio and video, so its own signature isn't enough.
  if (holds(b, ascii("RIFF")) && holds(b, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  return undefined;
}

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
};

/**
 * What to tell a sender whose name or declared type names one of these formats when the bytes
 * show another, or undefined when nothing contradicts them. A name or type outside the formats
 * claims nothing here, as `application/octet-stream` doesn't. The name comes first, since a
 * client that reads the type from the name then needs only the rename.
 */
export function imageLabelConflict(
  shown: string,
  label: { name: string; declared: string },
): string | undefined {
  const is = `This file is a ${FORMAT_NAMES[shown]}`;
  const named = imageTypeOfName(label.name);
  if (named && named !== shown) {
    return `${is}, but its name says ${FORMAT_NAMES[named]}. Rename it to match, or convert it.`;
  }
  const declared = mediaType(label.declared);
  if (RASTER_IMAGE_TYPES.includes(declared) && declared !== shown) {
    return `${is}, but its declared type says ${FORMAT_NAMES[declared]}. Send its real type, or convert it.`;
  }
  return undefined;
}
