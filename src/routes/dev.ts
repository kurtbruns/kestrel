/**
 * Dev-only tooling routes. Gated to a dev-shaped env: on any real provider
 * (staging/production) these 404, so they can never touch a provisioned database,
 * a real inbox, or mint a credential once Access is the gate.
 *
 *   GET  /api/dev/token → mint a local admin token (the editor's + seed's bootstrap).
 *   POST /api/dev/seed  → reset the DB and load the local "Windbreak" dataset.
 *                         Optional multipart `kestrel` file becomes the cover image.
 */

import { mintDevToken } from "../auth/dev_token";
import { resetAll } from "../db/seed";
import { BRANDING_LOGO_KEY } from "../db/settings";
import { seedDatabase } from "../dev/seed";
import { json, notFound } from "../lib/errors";
import type { RequestContext } from "../router";

/**
 * Bootstrap credential for local dev. Public by necessity — it is the thing that
 * hands out the admin token — but inert once deployed: `devAuthSecret` is resolved
 * only in a dev-shaped env and the secret is never committed (it lives in the
 * gitignored `.dev.vars`), so this 404s the moment Access is the gate. A token with
 * no `email` is a `service` principal, mirroring Claude in production.
 */
export async function token(c: RequestContext): Promise<Response> {
  if (!c.config.devAuthSecret) {
    throw notFound("not available for this transport");
  }
  const service = c.url.searchParams.get("kind") === "service";
  const jwt = await mintDevToken(c.config.devAuthSecret, service ? {} : { email: "dev@localhost" });
  return json({ token: jwt, kind: service ? "service" : "human" });
}

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

/**
 * The reverse of the seed: wipe the local database back to a fresh install — no
 * posts, no subscribers, and default settings (so the publication identity resets
 * too) — for viewing the first-run dashboard and setup checklist. Dev-only, like
 * the seed: 404s on any real provider so it can never wipe a provisioned database.
 */
export async function reset(c: RequestContext): Promise<Response> {
  if (c.config.provider !== "fake") {
    throw notFound("not available for this transport");
  }
  await resetAll(c.env.DB);
  // Also clear the settings singleton (identity + preferences) and the one global
  // branding asset, so a fresh reset shows the From-name fallback and no logo.
  await c.env.DB.prepare("DELETE FROM settings").run();
  try {
    await c.env.MEDIA.delete(BRANDING_LOGO_KEY);
  } catch {
    /* best effort — an absent logo is fine */
  }
  return json({ reset: true, url: `${c.config.appOrigin}/dashboard/` });
}
