/**
 * App settings surface (authed admin). Four parts:
 *
 *   GET    /api/settings      → { settings, deployment, template }
 *   PUT    /api/settings      → update editable settings (merge), returns { settings, template,
 *                               warnings, scheduled_posts_kept } (the last two on a template save)
 *   POST   /api/settings/logo → upload the publication logo (multipart `file`)
 *   DELETE /api/settings/logo → remove the publication logo
 *   GET    /api/settings/template/revisions             → the template's history
 *   POST   /api/settings/template/revisions/:id/restore → make a past revision current, as a new one
 *
 * `settings` are the mutable, in-app preferences (src/db/settings.ts) — including
 * the publication identity: name, tagline, and logo. `template` is the current
 * template revision (SPEC §9): a template save writes a revision, and a send pins
 * the one it was made with, so the save reports which scheduled sends keep the
 * previous revision (`scheduled_posts_kept`) rather than changing them silently.
 * `deployment` is a READ-ONLY reflection of the env-resolved Config — which
 * provider is live, the From address, the origins, whether Access is configured —
 * so the editor can show what was set at deploy time and link to the setup docs
 * for how to change it. It deliberately exposes NO secrets (SPEC §9/§11): the
 * provider credentials, the Access AUD, and the dev secret never appear here.
 */

import { buildInfo } from "../build";
import { scheduledSendsNotOn } from "../db/sends";
import {
  type AppSettings,
  BRANDING_LOGO_KEY,
  DEFAULT_CONFIRMATION_EMAIL,
  getSettings,
  MAX_TEMPLATE,
  resolveConfirmationEmail,
  type SettingsPatch,
  setPublicationLogo,
  updateSettings,
} from "../db/settings";
import { listTemplateRevisions, templateRevisionRef } from "../db/template_revisions";
import type { Config } from "../env";
import { badRequest, json, notFound } from "../lib/errors";
import { DEFAULT_EMAIL_TEMPLATE, validateEmailTemplate } from "../render/template_engine";
import type { RequestContext } from "../router";
import { param } from "../router";
import {
  currentTemplateRevision,
  restoreTemplateRevision,
  saveTemplate,
} from "../services/template_history";

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
    // The running build (SPEC §9), so the editor can show/link it. Build metadata,
    // resolved at build (src/build.ts) — not deploy config, and never a secret.
    build: buildInfo(),
  };
}

/** The publication identity as the clients consume it: the stored fields plus a
 *  resolved absolute `logoUrl` (cache-busted). The raw logo metadata (R2 version)
 *  is an implementation detail. */
function publicationView(settings: AppSettings, cfg: Config) {
  const p = settings.publication;
  return {
    name: p.name,
    tagline: p.tagline,
    address: p.address,
    logoUrl: p.logo ? `${cfg.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
  };
}

function settingsView(settings: AppSettings, cfg: Config) {
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

function author(c: RequestContext): string | null {
  return c.principal?.email ?? c.principal?.kind ?? null;
}

export async function get(c: RequestContext): Promise<Response> {
  // Reading the current revision records the initial template as revision one on a
  // fresh install, so the surface always has a revision to show.
  const template = templateRevisionRef(await currentTemplateRevision(c.env.DB));
  const settings = await getSettings(c.env.DB);
  return json({
    settings: settingsView(settings, c.config),
    deployment: deploymentView(c.config),
    template,
  });
}

export async function update(c: RequestContext): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("a JSON body is required");
  }
  const { patch, emailTemplate } = readPatch(body);
  // Structural template validation: a missing unsubscribe (or body) is an error and
  // rejects the write — no email may ship without a way to leave (I2). Other issues
  // are warnings, returned so the client can surface them without blocking. An empty
  // template is rejected like any other invalid one (it's missing both required
  // variables), so clearing the editor and saving reports the error rather than
  // silently resetting to the default. (A never-set template still resolves to the
  // built-in default on read — see settingsView / resolveBranding.)
  let warnings: string[] = [];
  if (emailTemplate !== undefined) {
    if (emailTemplate.length > MAX_TEMPLATE) {
      throw badRequest(`emailTemplate must be ${MAX_TEMPLATE} characters or fewer`);
    }
    const v = validateEmailTemplate(emailTemplate);
    if (v.errors.length > 0) {
      throw badRequest(v.errors.join(" "));
    }
    warnings = v.warnings;
  }
  try {
    // The preferences first: their validation throws before anything is written, so
    // an invalid field never leaves a template revision behind.
    let settings = await updateSettings(c.env.DB, patch);
    let template = templateRevisionRef(await currentTemplateRevision(c.env.DB));
    if (emailTemplate === undefined) {
      return json({ settings: settingsView(settings, c.config), template, warnings });
    }
    // A template save writes a revision and reports the scheduled sends it does NOT
    // change (SPEC §9): each keeps the revision it was made with until updated.
    const saved = await saveTemplate(c.env.DB, emailTemplate, author(c));
    settings = await getSettings(c.env.DB);
    template = templateRevisionRef(saved.revision);
    const scheduled_posts_kept = await scheduledSendsNotOn(c.env.DB, saved.revision.id);
    return json({
      settings: settingsView(settings, c.config),
      template,
      warnings,
      scheduled_posts_kept,
    });
  } catch (e) {
    // updateSettings / saveTemplate throw plain Errors for invalid input (a bad
    // address, too many recipients, an oversized template).
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
}

/** The template's history, newest first, each marked whether it is the current one. */
export async function listRevisions(c: RequestContext): Promise<Response> {
  const current = await currentTemplateRevision(c.env.DB);
  const rows = await listTemplateRevisions(c.env.DB);
  return json({
    revisions: rows.map((r) => ({
      id: r.id,
      saved_at: r.saved_at,
      author: r.author,
      is_current: r.id === current.id,
    })),
    current: templateRevisionRef(current),
  });
}

/**
 * Restore a past revision (SPEC §9): a new revision equal to it becomes current; the
 * history is never rewritten. Like a save, it reports the scheduled sends it leaves on
 * the revision they had.
 */
export async function restoreRevision(c: RequestContext): Promise<Response> {
  const saved = await restoreTemplateRevision(c.env.DB, param(c, "id"), author(c));
  if (!saved) {
    throw notFound("template revision");
  }
  const settings = await getSettings(c.env.DB);
  const scheduled_posts_kept = await scheduledSendsNotOn(c.env.DB, saved.revision.id);
  return json({
    settings: settingsView(settings, c.config),
    template: templateRevisionRef(saved.revision),
    restored_from: param(c, "id"),
    scheduled_posts_kept,
  });
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
  // The `?v=` cache-buster is a timestamp, not a counter: it must strictly increase
  // even across a delete → re-upload, so it never reuses an old value and serves a
  // stale logo through a cache that ignores the ETag (self-hosted deployments vary).
  const version = Date.now();
  const settings = await setPublicationLogo(c.env.DB, { version, contentType: type });
  return json({ settings: settingsView(settings, c.config) });
}

export async function deleteLogo(c: RequestContext): Promise<Response> {
  await c.env.MEDIA.delete(BRANDING_LOGO_KEY);
  const settings = await setPublicationLogo(c.env.DB, null);
  return json({ settings: settingsView(settings, c.config) });
}

/** Pick only the known editable keys off the request body. The template rides beside
 *  the patch, not in it: it is saved through its history, not merged like a preference. */
function readPatch(body: unknown): { patch: SettingsPatch; emailTemplate?: string } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  let emailTemplate: string | undefined;
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
    emailTemplate = o.emailTemplate;
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
  return { patch, emailTemplate };
}
