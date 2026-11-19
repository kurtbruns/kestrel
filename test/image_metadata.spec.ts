import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { probeImageDimensions } from "../src/lib/image_dims";
import {
  exifOrientation,
  minimalExif,
  stripImageMetadata,
  unreadableImageMessage,
} from "../src/lib/image_metadata";
import { clearLogos, logoKeys, resetDatabase } from "./support/fixtures";
import { AUTH, base, GIF_1x1, JPEG_1x1, PNG_1x1, readJson, WEBP_1x1 } from "./support/http";

const text = (s: string) => new TextEncoder().encode(s);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Whether `needle` appears anywhere in `hay`. */
const contains = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
};

// The camera's serial, written where a phone writes its make: a stored image must never hold it.
const SERIAL = text("SN-4417-SECRET");
// A GPS latitude reference: the GPS directory's one entry.
const GPS_TAG = 0x0001;

/**
 * A phone's Exif, big-endian: IFD0 holds the make, `orientation`, and a pointer to a GPS
 * directory holding a latitude reference.
 */
function phoneExif(orientation: number): Uint8Array {
  const tiff = new Uint8Array(8 + 42 + SERIAL.length + 18);
  const dv = new DataView(tiff.buffer);
  tiff.set(text("MM"));
  dv.setUint16(2, 42);
  dv.setUint32(4, 8);
  dv.setUint16(8, 3);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    dv.setUint16(at, tag);
    dv.setUint16(at + 2, type);
    dv.setUint32(at + 4, count);
    dv.setUint32(at + 8, value);
  };
  const makeAt = 50;
  const gpsAt = makeAt + SERIAL.length;
  entry(10, 0x010f, 2, SERIAL.length, makeAt);
  entry(22, 0x0112, 3, 1, orientation << 16);
  entry(34, 0x8825, 4, 1, gpsAt);
  tiff.set(SERIAL, makeAt);
  dv.setUint16(gpsAt, 1);
  entry(gpsAt + 2, GPS_TAG, 2, 2, 0x4e000000); // "N"
  return tiff;
}

const XMP = text('<x:xmpmeta><rdf:Description exif:GPSLatitude="51,30.0N"/></x:xmpmeta>');
const ICC = text("fake ICC profile bytes");

// --- JPEG ---

const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array => {
  const seg = new Uint8Array(4 + payload.length);
  seg.set([0xff, marker]);
  new DataView(seg.buffer).setUint16(2, payload.length + 2);
  seg.set(payload, 4);
  return seg;
};

const exifApp1 = (tiff: Uint8Array) => jpegSegment(0xe1, concat(text("Exif\0\0"), tiff));
const iccApp2 = jpegSegment(0xe2, concat(text("ICC_PROFILE\0"), Uint8Array.of(1, 1), ICC));

// JPEG_1x1 opens with SOI and a JFIF APP0; the metadata goes after them, where a camera puts it.
const JFIF_END = 4 + new DataView(JPEG_1x1.buffer).getUint16(4);
const intoJpeg = (...segments: Uint8Array[]) =>
  concat(JPEG_1x1.subarray(0, JFIF_END), ...segments, JPEG_1x1.subarray(JFIF_END));

const PHONE_JPEG = intoJpeg(
  exifApp1(phoneExif(6)),
  jpegSegment(0xe1, concat(text("http://ns.adobe.com/xap/1.0/\0"), XMP)),
  iccApp2,
  jpegSegment(0xe2, concat(text("MPF\0"), text("index of appended images"))),
  jpegSegment(0xed, concat(text("Photoshop 3.0\0"), SERIAL)),
  jpegSegment(0xfe, text("taken at home")),
);
// What's stored: the orientation alone, then the colour profile.
const PHONE_JPEG_STORED = intoJpeg(exifApp1(minimalExif(6)), iccApp2);

// --- PNG ---

const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(text(type), 4);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
};

// PNG_1x1 is its signature and IHDR (33 bytes), then IDAT and IEND.
const IHDR_END = 33;
const intoPng = (...chunks: Uint8Array[]) =>
  concat(PNG_1x1.subarray(0, IHDR_END), ...chunks, PNG_1x1.subarray(IHDR_END));

const iccp = pngChunk("iCCP", concat(text("profile\0\0"), ICC));
const PHONE_PNG = intoPng(
  iccp,
  pngChunk("eXIf", phoneExif(6)),
  pngChunk("tEXt", concat(text("Author\0"), SERIAL)),
  pngChunk("iTXt", concat(text("XML:com.adobe.xmp\0\0\0\0\0"), XMP)),
  pngChunk("tIME", Uint8Array.of(0x07, 0xea, 11, 18, 9, 30, 0)),
);
const PHONE_PNG_STORED = intoPng(iccp, pngChunk("eXIf", minimalExif(6)));

// --- WebP ---

const riffChunk = (fourCc: string, data: Uint8Array): Uint8Array => {
  const chunk = new Uint8Array(8 + data.length + (data.length & 1));
  chunk.set(text(fourCc));
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  chunk.set(data, 8);
  return chunk;
};

/** An extended WebP of 1 × 1 with `flags` set, holding `chunks` after its header. */
const extendedWebp = (flags: number, ...chunks: Uint8Array[]): Uint8Array => {
  const vp8x = new Uint8Array(10);
  vp8x[0] = flags; // a canvas of 1 × 1 is stored as 0 × 0, each size minus one
  const body = concat(text("WEBP"), riffChunk("VP8X", vp8x), ...chunks);
  const out = concat(text("RIFF"), new Uint8Array(4), body);
  new DataView(out.buffer).setUint32(4, body.length, true);
  return out;
};

const ICC_FLAG = 0x20;
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;
const VP8 = WEBP_1x1.subarray(12); // the lossy image chunk of a real 1 × 1 WebP
const iccpWebp = riffChunk("ICCP", ICC);
const PHONE_WEBP = extendedWebp(
  ICC_FLAG | EXIF_FLAG | XMP_FLAG,
  iccpWebp,
  VP8,
  riffChunk("EXIF", phoneExif(6)),
  riffChunk("XMP ", XMP),
);
const PHONE_WEBP_STORED = extendedWebp(
  ICC_FLAG | EXIF_FLAG,
  iccpWebp,
  VP8,
  riffChunk("EXIF", minimalExif(6)),
);

// --- GIF ---

// GIF_1x1 is its header and a two-colour table (19 bytes), then a graphic control, image, and trailer.
const GCT_END = 19;
const xmpExtension = concat(
  Uint8Array.of(0x21, 0xff, 11),
  text("XMP DataXMP"),
  Uint8Array.of(XMP.length),
  XMP,
  Uint8Array.of(0),
);
const XMP_GIF = concat(GIF_1x1.subarray(0, GCT_END), xmpExtension, GIF_1x1.subarray(GCT_END));

describe("an uploaded image is stored without identifying metadata (SPEC §4)", () => {
  it("keeps a JPEG's colour profile and orientation, and drops its Exif, GPS, XMP, IPTC, and comments", () => {
    const stored = stripImageMetadata(PHONE_JPEG, "image/jpeg");
    expect(stored).toEqual(PHONE_JPEG_STORED);
    expect(contains(stored as Uint8Array, SERIAL)).toBe(false);
    expect(contains(stored as Uint8Array, XMP)).toBe(false);
    expect(probeImageDimensions(stored as Uint8Array)).toEqual(probeImageDimensions(PHONE_JPEG));
  });

  it("keeps a PNG's colour chunk and orientation, and drops its eXIf, text, XMP, and time", () => {
    const stored = stripImageMetadata(PHONE_PNG, "image/png");
    expect(stored).toEqual(PHONE_PNG_STORED);
    expect(probeImageDimensions(stored as Uint8Array)).toEqual({ width: 1, height: 1 });
  });

  it("keeps a WebP's colour profile and orientation, drops its EXIF and XMP, and says so in its header", () => {
    const stored = stripImageMetadata(PHONE_WEBP, "image/webp");
    expect(stored).toEqual(PHONE_WEBP_STORED);
    expect(probeImageDimensions(stored as Uint8Array)).toEqual({ width: 1, height: 1 });
  });

  it("drops a GIF's XMP and leaves the rest", () => {
    expect(stripImageMetadata(XMP_GIF, "image/gif")).toEqual(GIF_1x1);
  });

  it("keeps no Exif at all for an upright image", () => {
    expect(stripImageMetadata(intoJpeg(exifApp1(phoneExif(1)), iccApp2), "image/jpeg")).toEqual(
      intoJpeg(iccApp2),
    );
    expect(stripImageMetadata(intoPng(pngChunk("eXIf", phoneExif(1))), "image/png")).toEqual(
      PNG_1x1,
    );
    expect(
      stripImageMetadata(
        extendedWebp(EXIF_FLAG, VP8, riffChunk("EXIF", phoneExif(1))),
        "image/webp",
      ),
    ).toEqual(extendedWebp(0, VP8));
  });

  it("reads the orientation it keeps back as written", () => {
    for (const o of [2, 3, 4, 5, 6, 7, 8]) {
      expect(exifOrientation(minimalExif(o))).toBe(o);
    }
    expect(exifOrientation(phoneExif(8))).toBe(8);
    expect(exifOrientation(concat(text("Exif\0\0"), phoneExif(3)))).toBe(3);
  });

  it.each([
    ["JPEG", JPEG_1x1, "image/jpeg"],
    ["PNG", PNG_1x1, "image/png"],
    ["WebP", WEBP_1x1, "image/webp"],
    ["GIF", GIF_1x1, "image/gif"],
  ] as const)("stores a %s with no metadata exactly as sent", (_format, bytes, type) => {
    expect(stripImageMetadata(bytes, type)).toBe(bytes);
  });

  it("drops what a phone appends after a JPEG's or PNG's end, where further images carry their own Exif", () => {
    const appended = concat(Uint8Array.of(0xff, 0xd8), exifApp1(phoneExif(6)));
    const jpeg = concat(JPEG_1x1, Uint8Array.of(0xff, 0xd9));
    expect(stripImageMetadata(concat(jpeg, appended), "image/jpeg")).toEqual(jpeg);
    expect(stripImageMetadata(concat(PNG_1x1, SERIAL), "image/png")).toEqual(PNG_1x1);
  });

  it("drops a metadata section cut off by the end of the file", () => {
    const exif = exifApp1(phoneExif(6));
    const cut = concat(JPEG_1x1.subarray(0, JFIF_END), exif.subarray(0, 30));
    expect(stripImageMetadata(cut, "image/jpeg")).toEqual(JPEG_1x1.subarray(0, JFIF_END));
  });

  it("refuses a file whose structure can't be walked, since what follows couldn't be checked", () => {
    const gif = concat(GIF_1x1.subarray(0, GCT_END), Uint8Array.of(0x99), xmpExtension);
    expect(stripImageMetadata(gif, "image/gif")).toBeNull();
    const jpeg = intoJpeg(Uint8Array.of(0xff, 0xe1, 0x00, 0x01), exifApp1(phoneExif(6)));
    expect(stripImageMetadata(jpeg, "image/jpeg")).toBeNull();
  });
});

describe("the upload routes store the stripped bytes (SPEC §4, §9)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await clearLogos();
  });

  const newDraft = async (): Promise<string> =>
    (
      await readJson(
        await SELF.fetch(`${base}/api/posts`, {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({ subject: "Holiday photos" }),
        }),
      )
    ).post.id;

  const uploadTo = (id: string, bytes: Uint8Array, name: string) => {
    const fd = new FormData();
    fd.append("file", new File([bytes], name));
    return SELF.fetch(`${base}/api/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
  };

  const storedBytes = async (key: string) =>
    new Uint8Array(await ((await env.MEDIA.get(key)) as R2ObjectBody).arrayBuffer());

  it("stores a post image's photo without its location or camera, turned as it was", async () => {
    const id = await newDraft();
    const res = await uploadTo(id, PHONE_JPEG, "beach.jpg");
    expect(res.status).toBe(201);
    expect((await readJson(res)).image).toMatchObject({ width: 1, height: 1 });
    const stored = await storedBytes(`posts/${id}/beach.jpg`);
    expect(stored).toEqual(PHONE_JPEG_STORED);
    expect(contains(stored, SERIAL)).toBe(false);
  });

  it("stores the logo without its metadata", async () => {
    const fd = new FormData();
    fd.append("file", new File([PHONE_PNG], "logo.png", { type: "image/png" }));
    const res = await SELF.fetch(`${base}/api/settings/logo`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(res.status).toBe(200);
    const [key] = await logoKeys();
    expect(await storedBytes(key as string)).toEqual(PHONE_PNG_STORED);
  });

  it("refuses an image it can't check, naming the file, and stores nothing", async () => {
    const id = await newDraft();
    const gif = concat(GIF_1x1.subarray(0, GCT_END), Uint8Array.of(0x99));
    const res = await uploadTo(id, gif, "broken.gif");
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      field: "file",
      message: unreadableImageMessage("image/gif"),
    });
    expect(await env.MEDIA.get(`posts/${id}/broken.gif`)).toBeNull();
  });
});
