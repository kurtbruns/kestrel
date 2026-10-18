/**
 * App settings surface (authed admin). Three parts:
 *
 *   GET    /api/settings      → { settings, deployment, in_use, notification_status }
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
 * `in_use` is the scheduled sends a template or identity change would re-make, and
 * the identity fields the template renders (SPEC §9): the pre-flight a client reads
 * before saving. Every write goes through the re-make (send/remake.ts): a change
 * that reaches the email is refused until the client acknowledges those sends by id
 * (`remake`), and the response says what was re-made.
 * `notification_status` is how the notifications to the publisher have gone lately (SPEC
 * §8): the last delivered and any newer failure, so a channel that stopped working shows
 * where its destination is set.
 */

import {
  ADDRESS_NOT_PRINTED,
  type DeploymentView,
  type InUseView,
  type LogoResponse,
  type NotificationTestResponse,
  type PublicationView,
  type SettingsResponse,
  type SettingsSavedResponse,
  type SettingsView,
} from "../../shared/settings";
import { buildInfo } from "../build";
import { notificationStatus, recordNotificationTest } from "../db/notifications";
import { listScheduledSends } from "../db/sends";
import {
  type AppSettings,
  applyPatch,
  DEFAULT_CONFIRMATION_EMAIL,
  getSettings,
  newLogoKey,
  publicationLogoUrl,
  resolveConfirmationEmail,
  SettingsFieldError,
  type SettingsPatch,
  withPublicationLogo,
} from "../db/settings";
import { type AppEnv, type Config, onFreePlanLimits } from "../env";
import {
  fieldError,
  type JsonObject,
  onlyKeys,
  optObject,
  optString,
  optStringList,
  readJsonObject,
} from "../lib/body";
import { badRequest, HttpError, json } from "../lib/errors";
import { mediaType, RASTER_IMAGE_TYPES } from "../lib/image_types";
import { unwrap } from "../lib/unwrap";
import { getNotifier } from "../notify/channel";
import { sampleNotification } from "../notify/compose";
import { requireConnectedProvider } from "../providers";
import {
  DEFAULT_EMAIL_TEMPLATE,
  type IdentityField,
  identityFieldsInUse,
  resolveBranding,
  validateEmailTemplate,
} from "../render/template_engine";
import type { Principal, RequestContext } from "../router";
import { viewSendsInOrder } from "../send/describe";
import { insideLead, saveSettingsRemaking } from "../send/remake";

/** Logos are small brand assets; keep them well under any provider's object limits. */
export const MAX_LOGO_BYTES = 512 * 1024;

/** The non-secret, deploy-time facts the editor shows read-only, and how the reader of
 *  them signed in (`auth_mode`, from the principal: a per-request fact, never config). */
function deploymentView(cfg: Config, principal: Principal): DeploymentView {
  return {
    provider: cfg.provider,
    from_address: cfg.fromAddress,
    sending_domain: cfg.sendingDomain,
    app_origin: cfg.appOrigin,
    archive_origin: cfg.archiveOrigin,
    archive_base_path: cfg.archiveBasePath,
    media_public_base: cfg.mediaPublicBase,
    aws_region: cfg.awsRegion,
    // Booleans only — never the values.
    access_configured: Boolean(cfg.accessTeamDomain && cfg.accessAud),
    auth_mode: principal.via,
    // The running build (SPEC §9), so the editor can show/link it. Build metadata,
    // resolved at build (src/build.ts) — not deploy config, and never a secret.
    build: buildInfo(),
    // How notifications reach the publisher, and their sender: deploy config, shown so
    // the publisher knows which setup a failure points at. No credential rides either.
    notify_channel: cfg.notifyChannel,
    notify_from: cfg.notifyFrom,
    // The minimum lead (SPEC §6): deploy config, so the editor floors its pickers and words
    // its copy by the value this deployment enforces instead of a number of its own.
    min_lead_ms: cfg.minLeadMs,
    // Which provider the local send simulation models, so a dev tool can check it before a
    // demo; null in every deployed env.
    simulation: cfg.simulation,
    // Whether `provider: "none"` is local dev's preview of not connected, so the editor
    // words its way out as a restart rather than a deploy; false in every deployed env.
    not_connected_preview: cfg.notConnectedPreview,
    // Whether the deployment runs on Workers Free's limits, so the Schedule dialog can warn
    // before a send D1's daily writes may not cover, in the words the send's condition uses.
    free_plan_limits: onFreePlanLimits(cfg),
  };
}

/** The publication identity as the clients consume it: the stored fields plus a
 *  resolved absolute `logo_url` (the current upload's own address). The raw logo
 *  metadata (its version and R2 key) is an implementation detail. */
function publicationView(settings: AppSettings, cfg: Config): PublicationView {
  const p = settings.publication;
  return {
    name: p.name,
    tagline: p.tagline,
    address: p.address,
    logo_url: publicationLogoUrl(cfg.mediaPublicBase, p.logo),
  };
}

function settingsView(settings: AppSettings, cfg: Config): SettingsView {
  return {
    test_recipients: settings.testRecipients,
    publication: publicationView(settings, cfg),
    // Reflect the RESOLVED template — a blank stored value means "the built-in
    // default", so a client always receives a concrete template to show and edit.
    email_template: settings.emailTemplate.trim() ? settings.emailTemplate : DEFAULT_EMAIL_TEMPLATE,
    // The confirmation email: the resolved (effective) copy a client shows and edits,
    // plus the built-in default so "Reset to default" needs no hardcoded copy client-side.
    confirmation_email: resolveConfirmationEmail(settings),
    confirmation_email_default: DEFAULT_CONFIRMATION_EMAIL,
    notifications: settings.notifications,
  };
}

/** The identity fields the template in effect renders: `in_use.identity_fields`, and what
 *  the mailing-address warning reads. */
function renderedIdentityFields(settings: AppSettings, cfg: Config): IdentityField[] {
  return identityFieldsInUse(resolveBranding(settings, cfg).template);
}

/** The scheduled sends a template or identity change would re-make (SPEC §9), the
 *  moment after which a save stops being refused for the lead, and the identity fields
 *  the current template renders: what a client reads before it saves. */
async function inUseView(env: AppEnv, settings: AppSettings, cfg: Config): Promise<InUseView> {
  const scheduled = await listScheduledSends(env.DB);
  return {
    sends: await viewSendsInOrder(
      env,
      scheduled.map((s) => s.id),
    ),
    retry_after: insideLead(scheduled, cfg.minLeadMs, Date.now()).retryAfter,
    identity_fields: renderedIdentityFields(settings, cfg),
  };
}

/**
 * Run an act that writes the settings, or reads them to freeze a send. A refusal about the
 * settings' state, written at the same moment by another writer (`conflict`) or changed
 * under a freeze (`settings_changed`), carries the settings as they now stand
 * (docs/API.md, principle 5), so a client redraws them before it tries again.
 */
export async function carryingSettings<T>(c: RequestContext, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (err) {
    if (err instanceof HttpError && (err.code === "conflict" || err.code === "settings_changed")) {
      throw new HttpError(err.code, err.message, {
        ...err.details,
        settings: settingsView(await getSettings(c.env.DB), c.config),
      });
    }
    throw err;
  }
}

export async function get(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  const body: SettingsResponse = {
    settings: settingsView(settings, c.config),
    deployment: deploymentView(c.config, unwrap(c.principal, "principal")),
    in_use: await inUseView(c.env, settings, c.config),
    notification_status: await notificationStatus(c.env.DB),
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
    throw badRequest("Add a notifications address first, then send a test.", {
      field: "notifications.to",
    });
  }
  if (c.config.notifyChannel === "provider") {
    // Through the newsletter's provider, which is not there yet: refused like any test.
    requireConnectedProvider(c.config);
  }
  const notifier = getNotifier(c.config, c.env);
  try {
    await notifier.send(to, sampleNotification(c.config), `test-${Date.now()}`);
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    await recordNotificationTest(c.env.DB, error, Date.now());
    throw new HttpError("notify_failed", error);
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
  if (patch.email_template !== undefined) {
    const v = validateEmailTemplate(patch.email_template);
    if (v.errors.length > 0) {
      throw badRequest(v.errors.join(" "));
    }
    warnings = v.warnings;
  }
  // Validate the patch against the current settings up front, so a bad field is a 400
  // before any refusal about scheduled sends (applyPatch throws SettingsFieldError, naming
  // the field; any other Error is still a 400 rather than a 500). The read
  // stays outside the catch: a database failure is a 500, never reported as a bad request.
  const current = await getSettings(c.env.DB);
  try {
    applyPatch(current, patch);
  } catch (e) {
    if (e instanceof SettingsFieldError) {
      throw fieldError(e.field, e.message);
    }
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
  const { settings, remade } = await carryingSettings(c, () =>
    saveSettingsRemaking(c.env, c.config, (current) => applyPatch(current, patch), ack),
  );
  // A template or identity save that leaves an address the template doesn't print says
  // so, whichever half of that pair the save changed.
  if (
    (patch.email_template !== undefined || patch.publication !== undefined) &&
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

/** Store the uploaded logo's bytes under a key of their own, and make it the logo. */
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
    throw badRequest("The logo must be a PNG, JPEG, WebP, or GIF. Most email apps don’t show SVG.");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw badRequest("The logo file is empty.");
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw badRequest(`The logo must be ${MAX_LOGO_BYTES / 1024} KB or smaller.`);
  }
  // A timestamp names the upload's key, so a new upload never lands on an old key, even
  // after a removal, and nothing already sent changes what it shows (I3).
  const version = Date.now();
  const key = newLogoKey(version);
  // The logo is part of the identity, so the same re-make rule applies (SPEC §9); the
  // bytes are written only once the refusals are ruled out, so a refused upload never
  // leaves a new logo behind the old version.
  const ack = readAckQuery(c);
  const { settings, remade } = await carryingSettings(c, () =>
    saveSettingsRemaking(
      c.env,
      c.config,
      (current) => withPublicationLogo(current, { version, contentType: type, key }),
      ack,
      async () => {
        await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
      },
    ),
  );
  const body: LogoResponse = { settings: settingsView(settings, c.config), remade };
  return json(body);
}

export async function deleteLogo(c: RequestContext): Promise<Response> {
  const ack = readAckQuery(c);
  const { settings, remade } = await carryingSettings(c, () =>
    saveSettingsRemaking(
      c.env,
      c.config,
      (current) => withPublicationLogo(current, null),
      ack,
      // The bytes stay: emails already sent, and their archive pages, still show them (I3).
      // Removing the logo takes it out of what renders from now on, nothing more.
      async () => {},
    ),
  );
  const body: LogoResponse = { settings: settingsView(settings, c.config), remade };
  return json(body);
}

/**
 * Pick the editable keys off the request body. A key it doesn't take, or a present key with
 * the wrong type, is a 400 naming it (`publication.name`), so a misnamed field is never a
 * save that quietly changed nothing; the value rules (lengths, valid addresses) are
 * applyPatch's.
 */
function readPatch(o: JsonObject): SettingsPatch {
  onlyKeys(o, [
    "test_recipients",
    "publication",
    "email_template",
    "confirmation_email",
    "notifications",
    "remake",
  ]);
  const patch: SettingsPatch = {};
  const testRecipients = optStringList(o, "test_recipients");
  if (testRecipients !== undefined) {
    patch.test_recipients = testRecipients;
  }
  const p = optObject(o, "publication");
  if (p !== undefined) {
    onlyKeys(p, ["name", "tagline", "address"], "publication");
    const pub: NonNullable<SettingsPatch["publication"]> = {};
    for (const k of ["name", "tagline", "address"] as const) {
      const v = optString(p, k, "publication");
      if (v !== undefined) {
        pub[k] = v;
      }
    }
    patch.publication = pub;
  }
  const emailTemplate = optString(o, "email_template");
  if (emailTemplate !== undefined) {
    patch.email_template = emailTemplate;
  }
  const ceBody = optObject(o, "confirmation_email");
  if (ceBody !== undefined) {
    onlyKeys(ceBody, ["subject", "body", "button_label", "reassurance"], "confirmation_email");
    const ce: NonNullable<SettingsPatch["confirmation_email"]> = {};
    for (const k of ["subject", "body", "button_label", "reassurance"] as const) {
      const v = optString(ceBody, k, "confirmation_email");
      if (v !== undefined) {
        ce[k] = v;
      }
    }
    patch.confirmation_email = ce;
  }
  const nBody = optObject(o, "notifications");
  if (nBody !== undefined) {
    onlyKeys(nBody, ["to"], "notifications");
    const to = optString(nBody, "to", "notifications");
    patch.notifications = to === undefined ? {} : { to };
  }
  return patch;
}
