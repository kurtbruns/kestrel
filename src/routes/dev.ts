/**
 * Dev-only tooling routes. `app.ts` registers them only when `config.devMode` holds (the
 * one "this is local dev" predicate, see `getConfig`), so in any deployed env they do not
 * exist and can never touch a provisioned database, a real inbox, or mint a credential
 * once Access is the gate. Each handler checks `devMode` again, so reaching one through a
 * router built for another config still 404s.
 *
 *   GET  /api/dev/token → mint a local admin token (the editor's + seed's bootstrap), with
 *                         the `run_id` `kestrel dev` gave this run, which seed and reset
 *                         check against their directory's record before wiping anything.
 *   POST /api/dev/seed  → reset the DB and load the local "Field Notes" dataset.
 *                         Optional multipart files: `image` (repeatable, named
 *                         `<bundle>/<file>`) → an image a demo post shows, `logo` → the
 *                         publication logo. Optional query: `size`
 *                         (100 / 1k / 10k / 100k) scales the list via a seeded PRNG,
 *                         and `seed` pins it; absent, the curated demo list loads.
 *   GET  /api/dev/simulation → what the server simulates now, and whether each of the two
 *                         variables is as the server started or switched since.
 *   POST /api/dev/simulation → switch one or both on the running server (SPEC §10).
 */

import { mintDevToken } from "../auth/dev_token";
import { resetAll } from "../db/seed";
import { BRANDING_LOGO_KEY } from "../db/settings";
import { type DemoImageFile, parseSeedSize, seedDatabase } from "../dev/seed";
import { simulationState, switchSimulation } from "../dev/simulation_switch";
import { ConfigError } from "../env";
import { fieldError, optStringOrNull, readForm, readJsonObject } from "../lib/body";
import { badRequest, json, notFound } from "../lib/errors";
import { log } from "../lib/log";
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
 * `.dev.vars`). A token with no `email` is a `service` principal, mirroring a service
 * token, automation, in production.
 */
export async function token(c: RequestContext): Promise<Response> {
  requireDevMode(c);
  if (!c.config.devAuthSecret) {
    throw notFound("only available in local development");
  }
  // The router has held `kind` to `human` or `service`.
  const service = c.url.searchParams.get("kind") === "service";
  const jwt = await mintDevToken(c.config.devAuthSecret, service ? {} : { email: "dev@localhost" });
  return json({
    token: jwt,
    kind: service ? "service" : "human",
    ...(c.config.devRunId ? { run_id: c.config.devRunId } : {}),
  });
}

export async function seed(c: RequestContext): Promise<Response> {
  requireDevMode(c);

  const images: DemoImageFile[] = [];
  let logoFile: { bytes: ArrayBuffer; contentType: string } | undefined;
  const ct = c.req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await readForm(c.req);
    for (const file of form.getAll("image")) {
      // `<bundle>/<file>`: the post's folder under demo/posts, then the image beside it.
      const filename = file instanceof File ? file.name.replaceAll("\\", "/") : "";
      if (file instanceof File && /^[\w.-]+\/[\w.-]+$/.test(filename)) {
        images.push({
          bytes: await file.arrayBuffer(),
          contentType: file.type || "application/octet-stream",
          filename,
        });
      }
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
  // A value neither reads is refused naming it, never read as the curated list.
  const sizeRaw = c.url.searchParams.get("size");
  const size = parseSeedSize(sizeRaw);
  if (sizeRaw !== null && size === undefined) {
    throw fieldError("size", "size must be a count of subscribers, such as 100, 1k, or 10k");
  }
  const seedRaw = c.url.searchParams.get("seed");
  if (seedRaw !== null && !/^\d+$/.test(seedRaw)) {
    throw fieldError("seed", "seed must be a whole number");
  }
  const seed = seedRaw === null ? undefined : Number.parseInt(seedRaw, 10);
  const options = size != null ? { size, seed } : undefined;

  const summary = await seedDatabase(c.env, c.config, images, logoFile, options);
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
  // resetAll can't reach R2, so drop every logo upload here too — a fresh reset then
  // shows the From-name fallback and no logo. Only here, on a dev database being wiped:
  // a deployed logo's bytes are never deleted (I3).
  try {
    const { objects } = await c.env.MEDIA.list({ prefix: BRANDING_LOGO_KEY });
    await c.env.MEDIA.delete(objects.map((o) => o.key));
  } catch {
    /* best effort — an absent logo is fine */
  }
  return json({ reset: true, url: `${c.config.appOrigin}/dashboard/` });
}

/** What the server simulates now: the two variables, and where each value is from. */
export function simulation(c: RequestContext): Response {
  requireDevMode(c);
  return json(simulationState(c.env));
}

/**
 * Switch what the running server simulates (SPEC §10). The body's values are the variables'
 * own, and a pair the app would refuse to start with is refused here in the same words,
 * naming the field the refused variable came in as.
 */
export async function switchSimulated(c: RequestContext): Promise<Response> {
  requireDevMode(c);
  const body = await readJsonObject(c);
  const sends = optStringOrNull(body, "sends");
  const account = optStringOrNull(body, "account");
  if (sends === undefined && account === undefined) {
    throw badRequest(
      "give sends, account, or both: a string to switch to, or null for the value the server started with",
    );
  }
  try {
    switchSimulation(c.env, { sends, account }, Date.now());
  } catch (err) {
    if (err instanceof ConfigError) {
      throw fieldError(err.variable === "SIMULATE_ACCOUNT" ? "account" : "sends", err.message);
    }
    throw err;
  }
  const state = simulationState(c.env);
  log.info("dev.simulation_switched", { sends: state.sends, account: state.account });
  return json(state);
}
