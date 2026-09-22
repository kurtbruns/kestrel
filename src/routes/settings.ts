/**
 * App settings surface (authed admin). Three parts:
 *
 *   GET    /api/settings      → { settings, deployment, inUse }
 *   PUT    /api/settings      → update editable settings (merge), returns { settings, remade }
 *   POST   /api/settings/logo → upload the publication logo (multipart `file`)
 *   DELETE /api/settings/logo → remove the publication logo
 *
 * `settings` are the mutable, in-app preferences (src/db/settings.ts) — including
 * the publication identity: name, tagline, address, and logo.
 * `deployment` is a READ-ONLY reflection of the env-resolved Config — which
 * provider is live, the From address, the origins, whether Access is configured —
 * so the editor can show what was set at deploy time and link to the setup docs
 * for how to change it. It deliberately exposes NO secrets (SPEC §9/§11): the
 * provider credentials, the Access AUD, and the dev secret never appear here.
 * `inUse` is the scheduled sends a template or identity change would re-make, and
 * the identity fields the template renders (SPEC §9): the pre-flight a client reads
 * before saving. Every write goes through the re-make (send/remake.ts): a change
 * that reaches the email is refused until the client acknowledges those sends by id
 * (`remake`), and the response says what was re-made.
 */

import type {
  DeploymentView,
  InUseView,
  LogoResponse,
  PublicationView,
  SettingsResponse,
  SettingsSavedResponse,
  SettingsView,
} from "../../shared/settings";
import { buildInfo } from "../build";
import { listScheduledSends } from "../db/sends";
import {
  type AppSettings,
  applyPatch,
  BRANDING_LOGO_KEY,
  DEFAULT_CONFIRMATION_EMAIL,
  getSettings,
  resolveConfirmationEmail,
  type SettingsPatch,
  withPublicationLogo,
} from "../db/settings";
import type { Config } from "../env";
import { badRequest, json } from "../lib/errors";
import {
  DEFAULT_EMAIL_TEMPLATE,
  identityFieldsInUse,
  resolveBranding,
  validateEmailTemplate,
} from "../render/template_engine";
import type { RequestContext } from "../router";
import { insideLead, saveSettingsRemaking } from "../send/remake";

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
function deploymentView(cfg: Config): DeploymentView {
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
    // The running build (SPEC §9), so the editor can show/link it. Build metadata,
    // resolved at build (src/build.ts) — not deploy config, and never a secret.
    build: buildInfo(),
  };
}

/** The publication identity as the clients consume it: the stored fields plus a
 *  resolved absolute `logoUrl` (cache-busted). The raw logo metadata (R2 version)
 *  is an implementation detail. */
function publicationView(settings: AppSettings, cfg: Config): PublicationView {
  const p = settings.publication;
  return {
    name: p.name,
    tagline: p.tagline,
    address: p.address,
    logoUrl: p.logo ? `${cfg.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
  };
}

function settingsView(settings: AppSettings, cfg: Config): SettingsView {
  return {
    testRecipients: settings.testRecipients,
    publication: publicationView(settings, cfg),
    // Reflect the RESOLVED template — a blank stored value means "the built-in
    // default", so a client always receives a concrete template to show and edit.
    emailTemplate: settings.emailTemplate.trim() ? settings.emailTemplate : DEFAULT_EMAIL_TEMPLATE,
    // The confirmation email: the resolved (effective) copy a client shows and edits,
    // plus the built-in default so "Reset to default" needs no hardcoded copy client-side.
    confirmationEmail: resolveConfirmationEmail(settings),
    confirmationEmailDefault: DEFAULT_CONFIRMATION_EMAIL,
  };
}

/** The scheduled sends a template or identity change would re-make (SPEC §9), the
 *  moment after which a save stops being refused for the lead, and the identity fields
 *  the current template renders: what a client reads before it saves. */
async function inUseView(db: D1Database, settings: AppSettings, cfg: Config): Promise<InUseView> {
  const sends = await listScheduledSends(db);
  return {
    sends,
    retry_after: insideLead(sends, Date.now()).retryAfter,
    identityFields: identityFieldsInUse(resolveBranding(settings, cfg).template),
  };
}

export async function get(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  const body: SettingsResponse = {
    settings: settingsView(settings, c.config),
    deployment: deploymentView(c.config),
    inUse: await inUseView(c.env.DB, settings, c.config),
  };
  return json(body);
}

/** The acknowledged send ids from a JSON body's `remake` (a list of strings), or null. */
function readAck(o: Record<string, unknown>): string[] | null {
  if (!("remake" in o)) {
    return null;
  }
  if (!Array.isArray(o.remake) || !o.remake.every((id) => typeof id === "string")) {
    throw badRequest("remake must be a list of send ids");
  }
  return o.remake as string[];
}

/** The acknowledged send ids from the `remake` query parameter (comma-separated), for
 *  the logo routes, which carry no JSON body; null when absent. */
function readAckQuery(c: RequestContext): string[] | null {
  const raw = c.url.searchParams.get("remake");
  if (raw === null) {
    return null;
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function update(c: RequestContext): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("a JSON body is required");
  }
  const patch = readPatch(body);
  const ack = readAck((body && typeof body === "object" ? body : {}) as Record<string, unknown>);
  // Structural template validation: a missing unsubscribe (or body) is an error and
  // rejects the write — no email may ship without a way to leave (I2). Other issues
  // are warnings, returned so the client can surface them without blocking. An empty
  // template is rejected like any other invalid one (it's missing both required
  // variables), so clearing the editor and saving reports the error rather than
  // silently resetting to the default. (A never-set template still resolves to the
  // built-in default on read — see settingsView / resolveBranding.)
  let warnings: string[] = [];
  if (patch.emailTemplate !== undefined) {
    const v = validateEmailTemplate(patch.emailTemplate);
    if (v.errors.length > 0) {
      throw badRequest(v.errors.join(" "));
    }
    warnings = v.warnings;
  }
  // Validate the patch against the current settings up front, so a bad field is a 400
  // before any refusal about scheduled sends (applyPatch throws plain Errors).
  try {
    applyPatch(await getSettings(c.env.DB), patch);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
  const { settings, remade } = await saveSettingsRemaking(
    c.env,
    c.config,
    (current) => applyPatch(current, patch),
    ack,
  );
  const saved: SettingsSavedResponse = {
    settings: settingsView(settings, c.config),
    warnings,
    remade,
  };
  return json(saved);
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
  // The `?v=` cache-buster is a timestamp, not a counter: it must strictly increase
  // even across a delete → re-upload, so it never reuses an old value and serves a
  // stale logo through a cache that ignores the ETag (self-hosted deployments vary).
  const version = Date.now();
  // The logo is part of the identity, so the same re-make rule applies (SPEC §9); the
  // bytes are written only once the refusals are ruled out, so a refused upload never
  // leaves a new logo behind the old version.
  const ack = readAckQuery(c);
  const { settings, remade } = await saveSettingsRemaking(
    c.env,
    c.config,
    (current) => withPublicationLogo(current, { version, contentType: type }),
    ack,
    async () => {
      await c.env.MEDIA.put(BRANDING_LOGO_KEY, bytes, { httpMetadata: { contentType: type } });
    },
  );
  const body: LogoResponse = { settings: settingsView(settings, c.config), remade };
  return json(body);
}

export async function deleteLogo(c: RequestContext): Promise<Response> {
  const ack = readAckQuery(c);
  const { settings, remade } = await saveSettingsRemaking(
    c.env,
    c.config,
    (current) => withPublicationLogo(current, null),
    ack,
    () => c.env.MEDIA.delete(BRANDING_LOGO_KEY),
  );
  const body: LogoResponse = { settings: settingsView(settings, c.config), remade };
  return json(body);
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
    if ("address" in p) {
      pub.address = p.address as string;
    }
    patch.publication = pub;
  }
  if ("emailTemplate" in o) {
    if (typeof o.emailTemplate !== "string") {
      throw badRequest("emailTemplate must be a string");
    }
    patch.emailTemplate = o.emailTemplate;
  }
  if ("confirmationEmail" in o) {
    const c = (
      o.confirmationEmail && typeof o.confirmationEmail === "object" ? o.confirmationEmail : {}
    ) as Record<string, unknown>;
    const ce: NonNullable<SettingsPatch["confirmationEmail"]> = {};
    for (const k of ["subject", "body", "buttonLabel", "reassurance"] as const) {
      if (k in c) {
        if (typeof c[k] !== "string") {
          throw badRequest(`confirmationEmail.${k} must be a string`);
        }
        ce[k] = c[k] as string;
      }
    }
    patch.confirmationEmail = ce;
  }
  return patch;
}
