/**
 * Dev-only tooling routes. `app.ts` registers them only when `config.devMode` holds (the
 * one "this is local dev" predicate, see `getConfig`), so in any deployed env they do not
 * exist and can never touch a provisioned database, a real inbox, or mint a credential
 * once Access is the gate. Each handler checks `devMode` again, so reaching one through a
 * router built for another config still 404s.
 *
 *   GET  /api/dev/token → mint a local admin token (the editor's + seed's bootstrap).
 *   POST /api/dev/seed  → reset the DB and load the local "Windbreak" dataset.
 *                         Optional multipart files: `kestrel` → the cover image,
 *                         `logo` → the publication logo. Optional query: `size`
 *                         (100 / 1k / 10k / 100k) scales the list via a seeded PRNG,
 *                         and `seed` pins it; absent, the curated demo list loads.
 */

import { mintDevToken } from "../auth/dev_token";
import { resetAll } from "../db/seed";
import { BRANDING_LOGO_KEY } from "../db/settings";
import { parseSeedSize, seedDatabase } from "../dev/seed";
import { json, notFound } from "../lib/errors";
import type { RequestContext } from "../router";

/** 404 unless this is local dev. */
function requireDevMode(c: RequestContext): void {
  if (!c.config.devMode) {
    throw notFound("only available in local development");
  }
}

/**
 * Bootstrap credential for local dev. Public by necessity (it is the thing that hands
 * out the admin token) but absent once deployed: `devAuthSecret` is resolved only in a
 * dev-shaped env and the secret is never committed (it lives in the gitignored
 * `.dev.vars`). A token with no `email` is a `service` principal, mirroring Claude in
 * production.
 */
export async function token(c: RequestContext): Promise<Response> {
  requireDevMode(c);
  if (!c.config.devAuthSecret) {
    throw notFound("only available in local development");
  }
  const service = c.url.searchParams.get("kind") === "service";
  const jwt = await mintDevToken(c.config.devAuthSecret, service ? {} : { email: "dev@localhost" });
  return json({ token: jwt, kind: service ? "service" : "human" });
}

export async function seed(c: RequestContext): Promise<Response> {
  requireDevMode(c);

  let kestrelFile: { bytes: ArrayBuffer; contentType: string; filename: string } | undefined;
  let logoFile: { bytes: ArrayBuffer; contentType: string } | undefined;
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
    const logo = form.get("logo");
    if (logo instanceof File) {
      logoFile = {
        bytes: await logo.arrayBuffer(),
        contentType: logo.type || "image/png",
      };
    }
  }

  // Optional scale controls: `?size=` (100 / 1k / 10k / 100k, an approximate target)
  // selects the parametric PRNG-driven list; absent, the curated demo list loads unchanged.
  // `?seed=` pins the PRNG so a given (size, seed) is reproducible.
  const size = parseSeedSize(c.url.searchParams.get("size"));
  const seedRaw = c.url.searchParams.get("seed");
  const seedNum = seedRaw ? Number.parseInt(seedRaw, 10) : Number.NaN;
  const seed = Number.isFinite(seedNum) ? seedNum : undefined;
  const options = size != null ? { size, seed } : undefined;

  const summary = await seedDatabase(c.env, c.config, kestrelFile, logoFile, options);
  return json(summary);
}

/**
 * The reverse of the seed: wipe the local database back to a fresh install — no
 * posts, no subscribers, and default settings (so the publication identity resets
 * too) — for viewing the first-run dashboard and setup checklist. Dev-only, like
 * the seed, so it can never wipe a provisioned database.
 */
export async function reset(c: RequestContext): Promise<Response> {
  requireDevMode(c);
  await resetAll(c.env.DB); // clears every D1 table, the settings singleton included
  // resetAll can't reach R2, so drop the one global branding asset here too — a fresh
  // reset then shows the From-name fallback and no logo.
  try {
    await c.env.MEDIA.delete(BRANDING_LOGO_KEY);
  } catch {
    /* best effort — an absent logo is fine */
  }
  return json({ reset: true, url: `${c.config.appOrigin}/dashboard/` });
}
