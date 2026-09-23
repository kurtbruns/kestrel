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
import { badRequest, conflict, json, notFound } from "../lib/errors";
import { probeImageDimensions } from "../lib/image_dims";
import type { RequestContext } from "../router";
import { param } from "../router";

/** The raster formats a post image may be: what mail clients show, and none that runs. */
const POST_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Generous for a photo, still small enough to send: every recipient downloads it. */
const MAX_POST_IMAGE_BYTES = 5 * 1024 * 1024;

function storageKey(postId: string, filename: string): string {
  return `posts/${postId}/${filename}`;
}

/** Strip any path components a client might sneak into a filename. */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
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

async function requireDraft(c: RequestContext): Promise<posts.PostRow> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  if (post.status !== "draft") {
    throw conflict("post is not a draft — cancel the schedule to edit");
  }
  return post;
}

export async function uploadImage(c: RequestContext): Promise<Response> {
  const post = await requireDraft(c);
  const ct = c.req.headers.get("content-type") ?? "";

  let filename: string;
  let contentType: string;
  let bytes: ArrayBuffer;

  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw badRequest("missing 'file' field");
    }
    const override = form.get("filename");
    filename = baseName(
      typeof override === "string" && override ? override : file.name || "upload",
    );
    contentType = file.type || "application/octet-stream";
    bytes = await file.arrayBuffer();
  } else {
    // Raw body upload: filename via query, content-type via header.
    filename = baseName(c.url.searchParams.get("filename") ?? "");
    if (!filename) {
      throw badRequest("filename query param required for a raw upload");
    }
    contentType = ct || "application/octet-stream";
    bytes = await c.req.arrayBuffer();
  }

  if (!filename) {
    throw badRequest("a filename is required");
  }
  // Raster images only, and not too large. The bytes are served back publicly, and a
  // public media bucket domain serves them without the /media route's sandbox headers,
  // so an SVG or HTML upload would run as a live page there. An email image has no need
  // to be either.
  if (!POST_IMAGE_TYPES.has(contentType)) {
    throw badRequest("an image must be a PNG, JPEG, WebP, or GIF");
  }
  if (bytes.byteLength === 0) {
    throw badRequest("the image file is empty");
  }
  if (bytes.byteLength > MAX_POST_IMAGE_BYTES) {
    throw badRequest(`an image must be ${MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB or smaller`);
  }

  const key = storageKey(post.id, filename);
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  const dims = probeImageDimensions(new Uint8Array(bytes));
  const row = await images.upsertImage(c.env.DB, {
    postId: post.id,
    filename,
    storageKey: key,
    contentType,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  });
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
