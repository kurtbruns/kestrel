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

/** POST /posts/:id/images */
export interface ImageUploadResponse {
  image: PostImage;
}

/** GET /posts/:id/images */
export interface ImageListResponse {
  images: PostImage[];
}
