/*
 * A file's media type, read from its extension. An instance reads an upload's format from its
 * bytes and holds the label to them, but this client also calls instances on older releases,
 * which read only what the multipart part declares and refuse one with no type, so it states one:
 * `kestrel api --form` does, and so does `kestrel seed`, which imports this rather than keep
 * its own copy (the client may not import from cli/, but cli/ imports from the client).
 */
import { extname } from "node:path";

/**
 * The extensions of the raster formats an instance takes as an image. The Worker's list is
 * src/lib/image_types.ts, mirrored since the client is plain Node; a spec holds the two equal.
 */
export const IMAGE_TYPE_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** What a file goes as when its extension says nothing: a statement of no kind, not a guess. */
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/** The media type a file's name says it is, in any case (a camera's `IMG_0042.JPG`). */
export function fileMediaType(path) {
  return IMAGE_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? UNKNOWN_MEDIA_TYPE;
}
