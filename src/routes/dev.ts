/**
 * Dev-only tooling routes. Gated to the `fake` transport exactly like the fake
 * outbox: on any real provider (staging/production) these 404, so they can never
 * touch a provisioned database or a real inbox.
 *
 *   POST /api/dev/seed  → reset the DB and load the local "Field Notes" dataset.
 *                         Optional multipart `kestrel` file becomes the cover image.
 */

import { seedDatabase } from "../dev/seed";
import { json, notFound } from "../lib/errors";
import type { RequestContext } from "../router";

export async function seed(c: RequestContext): Promise<Response> {
  if (c.config.provider !== "fake") {
    throw notFound("not available for this transport");
  }

  let kestrelFile: { bytes: ArrayBuffer; contentType: string; filename: string } | undefined;
  const ct = c.req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("kestrel");
    if (file instanceof File) {
      const filename = (file.name || "kestrel.jpg").split(/[\\/]/).pop() || "kestrel.jpg";
      kestrelFile = {
        bytes: await file.arrayBuffer(),
        contentType: file.type || "image/jpeg",
        filename,
      };
    }
  }

  const summary = await seedDatabase(c.env, c.config, kestrelFile);
  return json(summary);
}
