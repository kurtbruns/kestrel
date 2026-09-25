/**
 * App settings surface (authed admin). Three parts:
 *
 *   GET    /api/settings      → { settings, deployment, inUse }
 *   PUT    /api/settings      → update editable settings (merge), returns { settings, warnings, remade }
 *   POST   /api/settings/logo → upload the publication logo (multipart `file`)
 *   DELETE /api/settings/logo → remove the publication logo
 *   POST   /api/settings/notifications/test → a sample notification to the saved address
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
 * `notificationStatus` is how the notifications to the publisher have gone lately (SPEC
 * §8): the last delivered and any newer failure, so a channel that stopped working shows
 * where its destination is set.
 */

import type {
  DeploymentView,
  InUseView,
  LogoResponse,
  NotificationTestResponse,
  PublicationView,
  SettingsResponse,
  SettingsSavedResponse,
  SettingsView,
} from "../../shared/settings";
import { buildInfo } from "../build";
import { notificationStatus, recordNotificationTest } from "../db/notifications";
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
import { type JsonObject, optObject, optString, optStringList, readJsonObject } from "../lib/body";
import { badRequest, HttpError, json } from "../lib/errors";
import { mediaType, RASTER_IMAGE_TYPES } from "../lib/image_types";
import { getNotifier } from "../notify/channel";
import { sampleNotification } from "../notify/compose";
import {
  DEFAULT_EMAIL_TEMPLATE,
  type IdentityField,
  identityFieldsInUse,
  resolveBranding,
  validateEmailTemplate,
} from "../render/template_engine";
import type { RequestContext } from "../router";
import { insideLead, saveSettingsRemaking } from "../send/remake";

/** Logos are small brand assets; keep them well under any provider's object limits. */
const MAX_LOGO_BYTES = 512 * 1024;

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
    // How notifications reach the publisher, and their sender: deploy config, shown so
    // the publisher knows which setup a failure points at. No credential rides either.
    notifyChannel: cfg.notifyChannel,
    notifyFrom: cfg.notifyFrom,
    // The minimum lead (SPEC §6): deploy config, so the editor floors its pickers and words
    // its copy by the value this deployment enforces instead of a number of its own.
    minLeadMs: cfg.minLeadMs,
    // Which provider the local send simulation models, so a dev tool can check it before a
    // demo; null in every deployed env.
    simulation: cfg.simulation,
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
    notifications: settings.notifications,
  };
}

/** The identity fields the template in effect renders: `inUse.identityFields`, and what
 *  the mailing-address warning reads. */
function renderedIdentityFields(settings: AppSettings, cfg: Config): IdentityField[] {
  return identityFieldsInUse(resolveBranding(settings, cfg).template);
}

/** Said when a save leaves a mailing address set that the template doesn't print (SPEC
 *  §9). Advice, never a refusal: whether a publication needs an address is the
 *  publisher's call, and a template may carry one written in by hand. */
const ADDRESS_NOT_PRINTED =
  "You've added a mailing address in Settings, but this template doesn't include the {{ .Publication.Address }} field. If you send promotional email, add it to the footer. If you've written your address into the template yourself, or don't need to provide one, you can ignore this or remove the address in Settings.";

/** The scheduled sends a template or identity change would re-make (SPEC §9), the
 *  moment after which a save stops being refused for the lead, and the identity fields
 *  the current template renders: what a client reads before it saves. */
async function inUseView(db: D1Database, settings: AppSettings, cfg: Config): Promise<InUseView> {
  const sends = await listScheduledSends(db);
  return {
    sends,
    retry_after: insideLead(sends, cfg.minLeadMs, Date.now()).retryAfter,
    identityFields: renderedIdentityFields(settings, cfg),
  };
}

export async function get(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  const body: SettingsResponse = {
    settings: settingsView(settings, c.config),
    deployment: deploymentView(c.config),
    inUse: await inUseView(c.env.DB, settings, c.config),
    notificationStatus: await notificationStatus(c.env.DB),
  };
  return json(body);
}

/**
 * Send a sample notification to the saved address through the live channel, so the
 * publisher proves the channel (a verified Cloudflare destination, say) before a send
 * runs into a problem. It goes to the one saved address only, never one named in the
 * request, so this cannot become a way to mail an arbitrary inbox. Its outcome is
 * recorded as the latest test, so a test that gets through after a failure clears "Not
 * delivered" on the status line. The channel's refusal is a 502 carrying its words.
 */
export async function notificationTest(c: RequestContext): Promise<Response> {
  const { to } = (await getSettings(c.env.DB)).notifications;
  if (!to) {
    throw badRequest("set a notifications address first", { field: "notifications.to" });
  }
  const notifier = getNotifier(c.config, c.env);
  try {
    await notifier.send(to, sampleNotification(c.config), `test-${Date.now()}`);
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    await recordNotificationTest(c.env.DB, error, Date.now());
    throw new HttpError(502, "notify_failed", error);
  }
  await recordNotificationTest(c.env.DB, null, Date.now());
  const body: NotificationTestResponse = { to, channel: notifier.channel };
  return json(body);
}

/** The acknowledged send ids from a JSON body's `remake` (a list of strings), or null. */
function readAck(o: JsonObject): string[] | null {
  return optStringList(o, "remake") ?? null;
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
  const body = await readJsonObject(c);
  const patch = readPatch(body);
  const ack = readAck(body);
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
  // before any refusal about scheduled sends (applyPatch throws plain Errors). The read
  // stays outside the catch: a database failure is a 500, never reported as a bad request.
  const current = await getSettings(c.env.DB);
  try {
    applyPatch(current, patch);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
  const { settings, remade } = await saveSettingsRemaking(
    c.env,
    c.config,
    (current) => applyPatch(current, patch),
    ack,
  );
  // A template or identity save that leaves an address the template doesn't print says
  // so, whichever half of that pair the save changed.
  if (
    (patch.emailTemplate !== undefined || patch.publication !== undefined) &&
    settings.publication.address.trim() &&
    !renderedIdentityFields(settings, c.config).includes("address")
  ) {
    warnings = [...warnings, ADDRESS_NOT_PRINTED];
  }
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
  // The post images' allowlist: the logo rides in every email's sign-off, and most email
  // apps don't show an SVG. A logo stored before this rule was set keeps serving.
  const type = mediaType(file.type);
  if (!RASTER_IMAGE_TYPES.includes(type)) {
    throw badRequest("The logo must be a PNG, JPEG, WebP, or GIF. Most email apps don't show SVG.");
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

/**
 * Pick the known editable keys off the request body. A present key with the wrong type
 * is a 400 naming it (`publication.name`); the value rules (lengths, valid addresses)
 * are applyPatch's.
 */
function readPatch(o: JsonObject): SettingsPatch {
  const patch: SettingsPatch = {};
  const testRecipients = optStringList(o, "testRecipients");
  if (testRecipients !== undefined) {
    patch.testRecipients = testRecipients;
  }
  const p = optObject(o, "publication");
  if (p !== undefined) {
    const pub: NonNullable<SettingsPatch["publication"]> = {};
    for (const k of ["name", "tagline", "address"] as const) {
      const v = optString(p, k, "publication");
      if (v !== undefined) {
        pub[k] = v;
      }
    }
    patch.publication = pub;
  }
  const emailTemplate = optString(o, "emailTemplate");
  if (emailTemplate !== undefined) {
    patch.emailTemplate = emailTemplate;
  }
  const ceBody = optObject(o, "confirmationEmail");
  if (ceBody !== undefined) {
    const ce: NonNullable<SettingsPatch["confirmationEmail"]> = {};
    for (const k of ["subject", "body", "buttonLabel", "reassurance"] as const) {
      const v = optString(ceBody, k, "confirmationEmail");
      if (v !== undefined) {
        ce[k] = v;
      }
    }
    patch.confirmationEmail = ce;
  }
  const nBody = optObject(o, "notifications");
  if (nBody !== undefined) {
    const to = optString(nBody, "to", "notifications");
    patch.notifications = to === undefined ? {} : { to };
  }
  return patch;
}
