// A post's images as the API carries them (SPEC §4): the stored image with its public
// URL, and the bodies of the image routes. The Worker's routes produce these shapes and
// the editor consumes them; one definition, so neither can drift.

/** One image of a post: its name as the Markdown references it, and where it is served from. */
export interface PostImage {
  filename: string;
  content_type: string;
  width: number | null;
  height: number | null;
  url: string;
}

/** POST /api/posts/:id/images */
export interface ImageUploadResponse {
  image: PostImage;
}

/** GET /api/posts/:id/images */
export interface ImageListResponse {
  images: PostImage[];
}

/** The extensions of the raster image formats an upload may be, and the type each names. */
export const IMAGE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * The image type a file's name claims, in any case, or undefined when it claims none. Only
 * these extensions count: a screenshot's `9.41.00` has a dot in it and makes no claim.
 */
export function imageTypeOfName(name: string): string | undefined {
  return IMAGE_TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".")).toLowerCase()];
}
