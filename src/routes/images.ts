/**
 * Post images. Upload/list/delete are authed (admin); serving bytes at
 * `/media/:key` is public (readers + the archive load images unauthenticated).
 * In production images are served from a custom-domain public R2 bucket; the
 * `/media` route is the local-dev equivalent (and any Worker-proxied serving).
 */

import type { ImageRow } from "../db/images";
import * as images from "../db/images";
import * as posts from "../db/posts";
import { badRequest, conflict, json, notFound } from "../lib/errors";
import { probeImageDimensions } from "../lib/image_dims";
import type { RequestContext } from "../router";
import { param } from "../router";

function storageKey(postId: string, filename: string): string {
  return `posts/${postId}/${filename}`;
}

/** Strip any path components a client might sneak into a filename. */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function publicImage(c: RequestContext, row: ImageRow) {
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
  return json({ image: publicImage(c, row) }, 201);
}

export async function listImages(c: RequestContext): Promise<Response> {
  const post = await posts.getPost(c.env.DB, param(c, "id"));
  if (!post) {
    throw notFound("post");
  }
  const rows = await images.listImages(c.env.DB, post.id);
  return json({ images: rows.map((r) => publicImage(c, r)) });
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
  // Harden against a crafted SVG executing script on direct navigation (issue #81):
  // never sniff a declared type away, and sandbox the response so scripts and
  // same-origin access are disabled when the bytes are rendered as a document.
  // Loaded via <img> (posts + the logo) this is inert; it only bites a hostile SVG
  // opened directly. Covers per-post images and the branding logo alike.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  return new Response(obj.body, { headers });
}
