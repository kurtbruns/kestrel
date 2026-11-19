/**
 * Removes what an uploaded image says about where, when, and on what it was made, before the
 * bytes are stored and served publicly (SPEC §4, §9). A phone photo carries its GPS location,
 * the camera's make and serial, and timestamps in Exif or XMP, and a publisher dropping one into
 * a post would otherwise publish where they live without knowing.
 *
 * Only the file's container and metadata sections are edited; the pixels are never decoded or
 * re-encoded, so the image shows exactly as before. What each format keeps is what it needs to
 * display correctly: its colour profile, and its orientation when it is turned, rewritten as a
 * minimal Exif holding only that tag, since a phone often stores a portrait photo sideways with
 * a note to rotate it.
 *
 * A file cut short is still walked: each section runs to the end of what is there, and a
 * metadata section cut off is dropped like a whole one, since the upload takes a truncated image
 * (`image_types.ts` says why). A file whose structure can't be walked at all, so that what
 * follows can't be checked, is refused rather than stored with metadata possibly left in it.
 * Bytes after a file's end marker are dropped: a phone may append further images there, each
 * with its own Exif, and no viewer shows them.
 */

import { FORMAT_NAMES } from "./image_types";

/**
 * `b` without its identifying metadata, or null when its structure can't be walked. A file with
 * nothing to remove comes back as the same array, so an image with no metadata is stored as sent.
 * `type` is the format the bytes were already found to be (`imageTypeOf`).
 */
export function stripImageMetadata(b: Uint8Array, type: string): Uint8Array | null {
  switch (type) {
    case "image/jpeg":
      return stripJpeg(b);
    case "image/png":
      return stripPng(b);
    case "image/webp":
      return stripWebp(b);
    case "image/gif":
      return stripGif(b);
    default:
      return b;
  }
}

/** The refusal for a file `stripImageMetadata` couldn't walk, as a plain next step. */
export function unreadableImageMessage(type: string): string {
  return `This file is a ${FORMAT_NAMES[type]}, but part of it can’t be read, so it can’t be checked for a location or other details before it’s published. Export it again, or convert it.`;
}

/** The Exif tag for how a viewer should turn the image; 1 is upright. */
const ORIENTATION_TAG = 0x0112;

const EXIF_PREFIX = "Exif\0\0";

function ascii(b: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The Orientation an Exif block states in its first directory, or null when it states none or
 * can't be read. `exif` is a TIFF structure, optionally after the `Exif\0\0` that JPEG requires
 * and some PNG and WebP writers copy.
 */
export function exifOrientation(exif: Uint8Array): number | null {
  const tiff = ascii(exif, 0, 6) === EXIF_PREFIX ? exif.subarray(6) : exif;
  if (tiff.length < 8) {
    return null;
  }
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") {
    return null;
  }
  const little = order === "II";
  const dv = new DataView(tiff.buffer as ArrayBuffer, tiff.byteOffset, tiff.byteLength);
  if (dv.getUint16(2, little) !== 42) {
    return null;
  }
  const ifd = dv.getUint32(4, little);
  if (ifd + 2 > tiff.length) {
    return null;
  }
  const count = dv.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) {
      return null;
    }
    // A SHORT with one value, held in the first two bytes of the entry's value field.
    if (dv.getUint16(entry, little) === ORIENTATION_TAG && dv.getUint16(entry + 2, little) === 3) {
      const value = dv.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A TIFF structure holding one directory with only the Orientation tag. */
export function minimalExif(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  const dv = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d]); // "MM": big-endian
  dv.setUint16(2, 42);
  dv.setUint32(4, 8); // the directory follows the header
  dv.setUint16(8, 1); // one entry
  dv.setUint16(10, ORIENTATION_TAG);
  dv.setUint16(12, 3); // SHORT
  dv.setUint32(14, 1); // one value
  dv.setUint16(18, orientation);
  dv.setUint32(22, 0); // no further directory
  return tiff;
}

/** The orientation worth keeping from an Exif block: one that turns the image, else null. */
function turning(exif: Uint8Array): number | null {
  const o = exifOrientation(exif);
  return o !== null && o !== 1 ? o : null;
}

// --- JPEG ---------------------------------------------------------------------------------

/**
 * Whether a JPEG segment is metadata to drop. Kept: APP0 (JFIF), APP2 holding an ICC profile,
 * and APP14 (Adobe, which says how to read the colour channels). Every other application
 * segment is metadata, Exif and XMP (APP1) and Photoshop's IPTC (APP13) among them, and
 * so is a comment (COM). APP2 also carries the multi-picture index of the images a phone appends
 * after the end marker, which go with it.
 */
function isJpegMetadata(marker: number, segment: Uint8Array): boolean {
  if (marker === 0xfe) {
    return true;
  }
  if (marker < 0xe0 || marker > 0xef) {
    return false;
  }
  if (marker === 0xe0 || marker === 0xee) {
    return false;
  }
  return !(marker === 0xe2 && ascii(segment, 4, 12) === "ICC_PROFILE\0");
}

function jpegExifSegment(orientation: number): Uint8Array {
  const tiff = minimalExif(orientation);
  const segment = new Uint8Array(4 + EXIF_PREFIX.length + tiff.length);
  segment.set([0xff, 0xe1]);
  new DataView(segment.buffer).setUint16(2, segment.length - 2);
  segment.set(
    Array.from(EXIF_PREFIX, (ch) => ch.charCodeAt(0)),
    4,
  );
  segment.set(tiff, 4 + EXIF_PREFIX.length);
  return segment;
}

/** Markers with no length after them: TEM, the restart markers, and SOI. */
function isStandalone(marker: number): boolean {
  return (
    marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
  );
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let changed = false;
  let orientationRead = false;
  let off = 2;
  while (off < b.length) {
    // Bytes where a marker belongs are skipped by a decoder looking for the next one, so they
    // stay, and the walk carries on from that marker as the decoder would.
    if (b[off] !== 0xff) {
      const next = b.indexOf(0xff, off);
      const end = next < 0 ? b.length : next;
      kept.push(b.subarray(off, end));
      off = end;
      continue;
    }
    const marker = b[off + 1];
    if (marker === undefined || off + 4 > b.length) {
      kept.push(b.subarray(off));
      break;
    }
    if (marker === 0xff) {
      kept.push(b.subarray(off, off + 1)); // a fill byte before a marker
      off++;
      continue;
    }
    if (marker === 0xd9) {
      kept.push(b.subarray(off, off + 2));
      changed ||= off + 2 < b.length;
      break;
    }
    if (isStandalone(marker)) {
      kept.push(b.subarray(off, off + 2));
      off += 2;
      continue;
    }
    const length = dv.getUint16(off + 2);
    if (length < 2) {
      return null; // a length shorter than its own field: nothing after it can be found
    }
    const end = Math.min(off + 2 + length, b.length);
    const segment = b.subarray(off, end);
    if (isJpegMetadata(marker, segment)) {
      changed = true;
      // The first Exif states the orientation; any later APP1 is XMP or an extension of it.
      if (marker === 0xe1 && !orientationRead && ascii(segment, 4, 6) === EXIF_PREFIX) {
        orientationRead = true;
        const o = turning(segment.subarray(4));
        if (o !== null) {
          kept.push(jpegExifSegment(o));
        }
      }
    } else {
      kept.push(segment);
    }
    off = end;
    if (marker === 0xda) {
      // A scan's coded data runs to the next marker: an 0xFF in it is followed by a zero, a
      // restart marker, or another 0xFF.
      let p = off;
      while (p + 1 < b.length) {
        const n = b[p + 1] as number;
        if (b[p] === 0xff && n !== 0x00 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) {
          break;
        }
        p++;
      }
      if (p + 1 >= b.length) {
        p = b.length;
      }
      kept.push(b.subarray(off, p));
      off = p;
    }
  }
  return changed ? concat(kept) : b;
}

// --- PNG ----------------------------------------------------------------------------------

/**
 * PNG chunks that carry metadata: Exif, the three text chunks (XMP lives in `iTXt`, and
 * cameras and editors write their make, software, and dates in `tEXt`), and the time of the
 * last edit. Every other chunk stays, the colour chunks and an animation's among them.
 */
const PNG_METADATA = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(
    Array.from(type, (ch) => ch.charCodeAt(0)),
    4,
  );
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Browsers turn a PNG by the orientation in its `eXIf`, so a turned one keeps a minimal `eXIf`
 * holding only that, as a JPEG does.
 */
function stripPng(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let changed = false;
  let off = 8;
  while (off < b.length) {
    if (off + 8 > b.length) {
      kept.push(b.subarray(off)); // too short to name a chunk, so it holds nothing
      break;
    }
    const length = dv.getUint32(off);
    const type = ascii(b, off + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return null; // not a chunk: the walk has lost its place, so nothing after it can be found
    }
    const end = Math.min(off + 12 + length, b.length);
    if (PNG_METADATA.has(type)) {
      changed = true;
      if (type === "eXIf") {
        const o = turning(b.subarray(off + 8, Math.min(off + 8 + length, b.length)));
        if (o !== null) {
          kept.push(pngChunk("eXIf", minimalExif(o)));
        }
      }
    } else {
      kept.push(b.subarray(off, end));
    }
    off = end;
    if (type === "IEND") {
      changed ||= off < b.length;
      break;
    }
  }
  return changed ? concat(kept) : b;
}

// --- WebP ---------------------------------------------------------------------------------

/** The extended header's flags for Exif and XMP being present. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function webpChunk(fourCc: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + data.length + (data.length & 1));
  chunk.set(Array.from(fourCc, (ch) => ch.charCodeAt(0)));
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  chunk.set(data, 8);
  return chunk;
}

/**
 * Drops the `EXIF` and `XMP ` chunks and clears their flags in the extended header. Only an
 * extended WebP may carry Exif, so only one keeps a minimal `EXIF` for a turned image, flagged.
 */
function stripWebp(b: Uint8Array): Uint8Array {
  if (b.length < 12) {
    return b;
  }
  const dv = new DataView(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
  const extended = b.length >= 16 && ascii(b, 12, 4) === "VP8X";
  const kept: Uint8Array[] = [b.subarray(0, 12)];
  let changed = false;
  let exifKept = false;
  let off = 12;
  while (off < b.length) {
    if (off + 8 > b.length) {
      kept.push(b.subarray(off));
      break;
    }
    const fourCc = ascii(b, off, 4);
    const size = dv.getUint32(off + 4, true);
    const end = Math.min(off + 8 + size + (size & 1), b.length);
    if (fourCc === "EXIF" || fourCc === "XMP ") {
      changed = true;
      if (fourCc === "EXIF" && extended && !exifKept) {
        const o = turning(b.subarray(off + 8, Math.min(off + 8 + size, b.length)));
        if (o !== null) {
          kept.push(webpChunk("EXIF", minimalExif(o)));
          exifKept = true;
        }
      }
    } else {
      kept.push(b.subarray(off, end));
    }
    off = end;
  }
  if (!changed) {
    return b;
  }
  const out = concat(kept);
  const odv = new DataView(out.buffer);
  odv.setUint32(4, out.length - 8, true);
  if (extended && out.length > 20) {
    const flags = (out[20] as number) & ~(VP8X_EXIF | VP8X_XMP);
    out[20] = exifKept ? flags | VP8X_EXIF : flags;
  }
  return out;
}

// --- GIF ----------------------------------------------------------------------------------

/** Where a run of sub-blocks ends: after the zero-length one that closes it. */
function afterSubBlocks(b: Uint8Array, off: number): number {
  let at = off;
  while (at < b.length) {
    const size = b[at] as number;
    at += 1;
    if (size === 0) {
      return at;
    }
    at += size;
  }
  return b.length;
}

/** The size of a colour table its packed flags say follows, or 0 for none. */
function colourTableSize(flags: number): number {
  return flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0;
}

/**
 * Drops XMP, which a GIF holds in an application extension named `XMP DataXMP`, and leaves
 * every other block. A block that isn't an extension, an image, or the trailer can't be walked
 * past, so the file is refused.
 */
function stripGif(b: Uint8Array): Uint8Array | null {
  if (b.length < 13) {
    return b;
  }
  let off = Math.min(13 + colourTableSize(b[10] as number), b.length);
  const kept: Uint8Array[] = [b.subarray(0, off)];
  let changed = false;
  while (off < b.length) {
    const start = off;
    const introducer = b[off];
    if (introducer === 0x3b) {
      kept.push(b.subarray(off, off + 1));
      changed ||= off + 1 < b.length;
      break;
    }
    if (introducer === 0x21) {
      const isXmp =
        b[off + 1] === 0xff && b[off + 2] === 11 && ascii(b, off + 3, 11) === "XMP DataXMP";
      off = afterSubBlocks(b, off + 2);
      if (isXmp) {
        changed = true;
      } else {
        kept.push(b.subarray(start, off));
      }
      continue;
    }
    if (introducer === 0x2c) {
      if (off + 10 > b.length) {
        kept.push(b.subarray(off));
        break;
      }
      // The descriptor, its own colour table, and the byte before the image data.
      off = afterSubBlocks(b, off + 10 + colourTableSize(b[off + 9] as number) + 1);
      kept.push(b.subarray(start, off));
      continue;
    }
    return null;
  }
  return changed ? concat(kept) : b;
}
