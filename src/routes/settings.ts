/**
 * App settings surface (authed admin). Three parts:
 *
 *   GET    /api/settings      → { settings, deployment }
 *   PUT    /api/settings      → update editable settings (merge), returns { settings }
 *   POST   /api/settings/logo → upload the publication logo (multipart `file`)
 *   DELETE /api/settings/logo → remove the publication logo
 *
 * `settings` are the mutable, in-app preferences (src/db/settings.ts) — including
 * the publication identity (issue #81): name, tagline, brand color, and logo.
 * `deployment` is a READ-ONLY reflection of the env-resolved Config — which
 * provider is live, the From address, the origins, whether Access is configured —
 * so the editor can show what was set at deploy time and link to the setup docs
 * for how to change it. It deliberately exposes NO secrets (SPEC §8/§10): the
 * provider credentials, the Access AUD, and the dev secret never appear here.
 */

import {
  type AppSettings,
  BRANDING_LOGO_KEY,
  getSettings,
  readableTextColor,
  type SettingsPatch,
  setPublicationLogo,
  updateSettings,
} from "../db/settings";
import type { Config } from "../env";
import { badRequest, json } from "../lib/errors";
import type { RequestContext } from "../router";

/** Logos are small brand assets; keep them well under any provider's object limits. */
const MAX_LOGO_BYTES = 512 * 1024;
const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/** The non-secret, deploy-time facts the editor shows read-only. */
function deploymentView(cfg: Config) {
  return {
    provider: cfg.provider,
    fromAddress: cfg.fromAddress,
    sendingDomain: cfg.sendingDomain,
    appOrigin: cfg.appOrigin,
    archiveOrigin: cfg.archiveOrigin,
    archiveBasePath: cfg.archiveBasePath,
    mediaPublicBase: cfg.mediaPublicBase,
    awsRegion: cfg.awsRegion,
    // Booleans only — never the values.
    accessConfigured: Boolean(cfg.accessTeamDomain && cfg.accessAud),
    authMode: cfg.accessTeamDomain ? "access" : "dev",
  };
}

/** The publication identity as the clients consume it: the stored fields plus a
 *  resolved absolute `logoUrl` (cache-busted) and a readable text color for filled
 *  brand controls. The raw logo metadata (R2 version) is an implementation detail. */
function publicationView(settings: AppSettings, cfg: Config) {
  const p = settings.publication;
  return {
    name: p.name,
    tagline: p.tagline,
    brandColor: p.brandColor,
    brandTextColor: p.brandColor ? readableTextColor(p.brandColor) : "",
    logoUrl: p.logo ? `${cfg.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
  };
}

function settingsView(settings: AppSettings, cfg: Config) {
  return { testRecipients: settings.testRecipients, publication: publicationView(settings, cfg) };
}

export async function get(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  return json({ settings: settingsView(settings, c.config), deployment: deploymentView(c.config) });
}

export async function update(c: RequestContext): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("a JSON body is required");
  }
  const patch = readPatch(body);
  try {
    const settings = await updateSettings(c.env.DB, patch);
    return json({ settings: settingsView(settings, c.config) });
  } catch (e) {
    // updateSettings throws plain Errors for invalid input (bad address/color, too many).
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
}

/** Store the uploaded logo bytes under the reserved R2 key, then bump its version. */
export async function uploadLogo(c: RequestContext): Promise<Response> {
  const ct = c.req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    throw badRequest("a multipart form with a 'file' field is required");
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw badRequest("missing 'file' field");
  }
  const type = file.type || "application/octet-stream";
  if (!ALLOWED_LOGO_TYPES.has(type)) {
    throw badRequest("logo must be a PNG, JPEG, WebP, GIF, or SVG image");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw badRequest("the logo file is empty");
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw badRequest("logo must be 512 KB or smaller");
  }
  await c.env.MEDIA.put(BRANDING_LOGO_KEY, bytes, { httpMetadata: { contentType: type } });
  const current = await getSettings(c.env.DB);
  const version = (current.publication.logo?.version ?? 0) + 1;
  const settings = await setPublicationLogo(c.env.DB, { version, contentType: type });
  return json({ settings: settingsView(settings, c.config) });
}

export async function deleteLogo(c: RequestContext): Promise<Response> {
  await c.env.MEDIA.delete(BRANDING_LOGO_KEY);
  const settings = await setPublicationLogo(c.env.DB, null);
  return json({ settings: settingsView(settings, c.config) });
}

/** Pick only the known editable keys off the request body. */
function readPatch(body: unknown): SettingsPatch {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ("testRecipients" in o) {
    if (!Array.isArray(o.testRecipients)) {
      throw badRequest("testRecipients must be a list");
    }
    patch.testRecipients = o.testRecipients as string[];
  }
  if ("publication" in o) {
    const p = (o.publication && typeof o.publication === "object" ? o.publication : {}) as Record<
      string,
      unknown
    >;
    const pub: NonNullable<SettingsPatch["publication"]> = {};
    if ("name" in p) {
      pub.name = p.name as string;
    }
    if ("tagline" in p) {
      pub.tagline = p.tagline as string;
    }
    if ("brandColor" in p) {
      pub.brandColor = p.brandColor as string;
    }
    patch.publication = pub;
  }
  return patch;
}
