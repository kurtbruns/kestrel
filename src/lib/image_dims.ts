/**
 * Best-effort intrinsic image dimensions from the file header: no decoding, no dependencies.
 * Returns null for a size it can't read, which the renderer takes as unknown, leaving the image
 * to its `max-width` with no size attributes.
 *
 * A zero in the answer is a header stating a size its format can't show (a PNG's, a lossy
 * WebP's, a JPEG's width), which the upload refuses (SPEC §4). A JPEG stating a height of zero
 * or a GIF stating a zero is unknown instead, since either can still be a working image: a JPEG
 * may state its height in a later marker, and decoders size a GIF that states a screen of zero
 * from its first frame.
 */
export interface Dimensions {
  width: number;
  height: number;
}

export function probeImageDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 24) {
    return null;
  }
  const dv = new DataView(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16 height@20 (big-endian)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }

  // GIF: "GIF8", logical screen width@6 height@8 (little-endian)
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    const width = dv.getUint16(6, true);
    const height = dv.getUint16(8, true);
    return width && height ? { width, height } : null;
  }

  // JPEG: FF D8, then walk segments to the Start-Of-Frame marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    return probeJpeg(b, dv);
  }

  // WebP: "RIFF" at 0, "WEBP" at 8, and the name of its first chunk at 12
  if (fourCc(b, 0) === "RIFF" && fourCc(b, 8) === "WEBP") {
    return probeWebp(b, dv);
  }

  return null;
}

function fourCc(b: Uint8Array, offset: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + 4));
}

/** Each of WebP's three forms stores its size its own way, and checks its own length: only a
 * signature let the file this far, so it may stop anywhere after the first 24 bytes. */
function probeWebp(b: Uint8Array, dv: DataView): Dimensions | null {
  const chunk = fourCc(b, 12);
  // Lossy: a start code at 23, then little-endian sizes at 26 and 28 whose top two bits are a scale
  if (chunk === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return null;
    }
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  // Lossless: a signature at 20, then a little-endian word at 21 of two 14-bit sizes, each minus one
  if (chunk === "VP8L") {
    if (b.length < 25 || b[20] !== 0x2f) {
      return null;
    }
    const sizes = dv.getUint32(21, true);
    return { width: (sizes & 0x3fff) + 1, height: ((sizes >>> 14) & 0x3fff) + 1 };
  }
  // Extended: 24-bit little-endian canvas sizes at 24 and 27, each minus one
  if (chunk === "VP8X") {
    if (b.length < 30) {
      return null;
    }
    const canvasSize = (at: number) => (dv.getUint16(at, true) | (dv.getUint8(at + 2) << 16)) + 1;
    return { width: canvasSize(24), height: canvasSize(27) };
  }
  return null;
}

function probeJpeg(b: Uint8Array, dv: DataView): Dimensions | null {
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    // SOF0..SOF15, excluding DHT (C4), JPG (C8), DAC (CC)
    if (
      marker !== undefined &&
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const width = dv.getUint16(off + 7);
      const height = dv.getUint16(off + 5);
      // The format lets a frame's height be 0, with the real one in a later DNL marker, so that's
      // unknown. It requires a width of at least 1, so a zero there stays in the answer.
      return width > 0 && height === 0 ? null : { width, height };
    }
    // Otherwise skip this segment using its length field.
    const len = dv.getUint16(off + 2);
    if (len < 2) {
      return null;
    }
    off += 2 + len;
  }
  return null;
}
