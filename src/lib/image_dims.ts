/**
 * Best-effort intrinsic image dimensions from the file header — no decoding,
 * no dependencies. Covers the formats that matter for email (PNG, JPEG, GIF).
 * Returns null for anything it can't read; the renderer (M3) treats null as
 * "unknown" and falls back to sensible defaults.
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
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }

  // JPEG: FF D8, then walk segments to the Start-Of-Frame marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    return probeJpeg(b, dv);
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
      return { width: dv.getUint16(off + 7), height: dv.getUint16(off + 5) };
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
