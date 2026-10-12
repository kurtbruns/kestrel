// An image file made square: the largest centered square, scaled to a fixed size and
// encoded as PNG in the browser, so a logo of any shape uploads as the square it is shown as.

/** The largest centered square of a `width` × `height` image, as a source rectangle. */
export function centerSquare(
  width: number,
  height: number,
): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** The file isn't an image this browser can decode (not an image at all, or a format it
 *  doesn't read), as distinct from a browser that can't make the PNG. */
export class UnreadableImage extends Error {
  constructor() {
    super("Couldn’t read that image. Pick a PNG, JPEG, WebP, or GIF.");
  }
}

/** An image squared to `size` × `size`: the PNG, and the source's own dimensions, so a
 *  caller can say when the source was cropped. */
export interface SquaredImage {
  png: Blob;
  width: number;
  height: number;
}

/**
 * Decode `file`, crop its centered square, scale it to `size` × `size`, and encode a PNG.
 * PNG keeps transparency and shows in every mail client, which WebP doesn't. An animated
 * GIF keeps its first frame. Rejects with `UnreadableImage` when the file isn't an image the
 * browser can decode, and with a plain Error when the browser can't make the PNG.
 */
export async function squareImage(file: Blob, size: number): Promise<SquaredImage> {
  // Upright as the photo was taken: a phone JPEG's EXIF rotation applied, said outright
  // rather than left to a default browsers have not always agreed on.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => {
    throw new UnreadableImage();
  });
  try {
    const { x, y, side } = centerSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("This browser can't prepare the image.");
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, x, y, side, side, 0, 0, size, size);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("This browser can't prepare the image."))),
        "image/png",
      ),
    );
    return { png, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
