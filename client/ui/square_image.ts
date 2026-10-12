// An image file made square: the largest centered square, scaled to a fixed size and
// encoded as PNG in the browser, so what is uploaded is exactly what was previewed.

/** The largest centered square of a `width` × `height` image, as a source rectangle. */
export function centerSquare(
  width: number,
  height: number,
): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** An image squared to `size` × `size`: the PNG, a URL that shows it, and the source's own
 *  dimensions, so a caller can say when the source was too small or was cropped. */
export interface SquaredImage {
  png: Blob;
  url: string;
  width: number;
  height: number;
}

/**
 * Decode `file`, crop its centered square, scale it to `size` × `size`, and encode a PNG.
 * PNG keeps transparency and shows in every mail client, which WebP doesn't. An animated
 * GIF keeps its first frame. Rejects when the file isn't an image the browser can decode.
 * The caller revokes `url` once the preview is gone.
 */
export async function squareImage(file: Blob, size: number): Promise<SquaredImage> {
  const bitmap = await createImageBitmap(file);
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
    return { png, url: URL.createObjectURL(png), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
