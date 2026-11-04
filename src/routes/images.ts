/**
 * Post images. Upload/list/delete are authed (admin); serving bytes at
 * `/media/:key` is public (readers + the archive load images unauthenticated).
 * In production images are served from a custom-domain public R2 bucket; the
 * `/media` route is the local-dev equivalent (and any Worker-proxied serving).
 */

import type { ImageListResponse, ImageUploadResponse, PostImage } from "../../shared/images";
import type { ImageRow } from "../db/images";
import * as images from "../db/images";
import * as posts from "../db/posts";
import { readForm } from "../lib/body";
import { badRequest, json, notFound } from "../lib/errors";
import { probeImageDimensions } from "../lib/image_dims";
import { mediaType, RASTER_IMAGE_TYPES } from "../lib/image_types";
import type { RequestContext } from "../router";
import { param } from "../router";
import { requireDraft } from "./posts";

/** Generous for a photo, still small enough to send: every recipient downloads it. */
export const MAX_POST_IMAGE_BYTES = 5 * 1024 * 1024;

function storageKey(postId: string, filename: string): string {
  return `posts/${postId}/${filename}`;
}

/** Strip any path components a client might sneak into a filename. */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * What a name can't hold and still work as a reference: whitespace of any kind (macOS puts a
 * narrow no-break space before "AM" in a screenshot's name) and control characters, which
 * end a Markdown link destination; the brackets and backtick that have meanings of their own
 * in Markdown; and the characters that change what the address built from the name asks for.
 */
const UNREFERENCEABLE = /[\s\p{Cc}<>()[\]`#?%]+/gu;

/**
 * The name to store an upload under, so that `![alt](name)` always becomes an image (SPEC §4):
 * each run of characters that would break the reference becomes a hyphen, and the case stays.
 * A hyphen at either end of the name or before a dot goes, since the name shows in a public
 * address. A name with nothing else in it comes back empty, for the caller's refusal. Only an
 * upload names an image this way: an image stored before this rule keeps its name, and a
 * delete looks up exactly the name the post has.
 */
function cleanName(name: string): string {
  return baseName(name)
    .replace(UNREFERENCEABLE, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+\./g, ".");
}

/** A name's nth candidate on a post: `image.png`, `image-2.png`, `image-3.png`. */
function numberedName(filename: string, n: number): string {
  if (n === 1) {
    return filename;
  }
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? `${filename.slice(0, dot)}-${n}${filename.slice(dot)}` : `${filename}-${n}`;
}

function publicImage(c: RequestContext, row: ImageRow): PostImage {
  return {
    filename: row.filename,
    content_type: row.content_type,
    width: row.width,
    height: row.height,
    url: `${c.config.mediaPublicBase}/${row.storage_key}`,
  };
}

export async function uploadImage(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const ct = c.req.headers.get("content-type") ?? "";

  let filename: string;
  let contentType: string;
  let bytes: ArrayBuffer;
  // What a refusal of the image itself names: the form's `file`, or, for a raw upload, the
  // body as a whole, which is no field.
  let imageField: { field: string } | undefined;

  if (ct.includes("multipart/form-data")) {
    const form = await readForm(c.req);
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw badRequest("missing 'file' field", { field: "file" });
    }
    imageField = { field: "file" };
    const override = form.get("filename");
    filename = cleanName(
      typeof override === "string" && override ? override : file.name || "upload",
    );
    contentType = mediaType(file.type);
    bytes = await file.arrayBuffer();
  } else {
    // Raw body upload: filename via query, content-type via header.
    filename = cleanName(c.url.searchParams.get("filename") ?? "");
    contentType = mediaType(ct);
    bytes = await c.req.arrayBuffer();
  }

  if (!filename) {
    throw badRequest("a filename is required", { field: "filename" });
  }
  // Raster images only (lib/image_types says why), and not too large.
  if (!RASTER_IMAGE_TYPES.includes(contentType)) {
    throw badRequest("An image must be a PNG, JPEG, WebP, or GIF.", imageField);
  }
  if (bytes.byteLength === 0) {
    throw badRequest("The image file is empty.", imageField);
  }
  if (bytes.byteLength > MAX_POST_IMAGE_BYTES) {
    throw badRequest(
      `An image must be ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`,
      imageField,
    );
  }

  // An upload never replaces an image (SPEC §4). A browser names every pasted image the same,
  // so replacing would leave each reference showing the last paste, at an address a browser
  // may have cached the first under. The name is claimed before the bytes are written, since
  // the editor uploads a paste's or a drop's files at the same time. A Worker lost between
  // the two leaves a row with no bytes, which a reference to it would send as a broken image.
  const dims = probeImageDimensions(new Uint8Array(bytes));
  let row: ImageRow | null = null;
  for (let n = 1; !row; n++) {
    const candidate = numberedName(filename, n);
    row = await images.insertImageIfNameFree(c.env.DB, {
      postId: post.id,
      filename: candidate,
      storageKey: storageKey(post.id, candidate),
      contentType,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
  }
  try {
    await c.env.MEDIA.put(row.storage_key, bytes, { httpMetadata: { contentType } });
  } catch (e) {
    await images.deleteImageRow(c.env.DB, post.id, row.filename);
    throw e;
  }
  const body: ImageUploadResponse = { image: publicImage(c, row) };
  return json(body, 201);
}

export async function listImages(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const rows = await images.listImages(c.env.DB, post.id);
  const body: ImageListResponse = { images: rows.map((r) => publicImage(c, r)) };
  return json(body);
}

export async function deleteImage(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const filename = baseName(param(c, "filename"));
  const row = await images.getImage(c.env.DB, post.id, filename);
  if (!row) {
    throw notFound("image");
  }
  await c.env.MEDIA.delete(row.storage_key);
  await images.deleteImageRow(c.env.DB, post.id, filename);
  return json({ deleted: true });
}

/** Public: stream an R2 object's bytes. */
export async function serveMedia(c: RequestContext): Promise<Response> {
  const key = param(c, "key");
  if (!key) {
    throw notFound("media");
  }
  const obj = await c.env.MEDIA.get(key);
  if (!obj) {
    throw notFound("media");
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  // Harden against a crafted SVG executing script on direct navigation:
  // never sniff a declared type away, and sandbox the response so scripts and
  // same-origin access are disabled when the bytes are rendered as a document.
  // Loaded via <img> (posts + the logo) this is inert; it only bites a hostile SVG
  // opened directly. Covers per-post images and the branding logo alike.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  return new Response(obj.body, { headers });
}
