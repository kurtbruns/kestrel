/**
 * App settings surface (authed admin). Two halves with different owners:
 *
 *   GET  /api/settings → { settings, deployment }
 *   PUT  /api/settings → update editable settings (merge), returns { settings }
 *
 * `settings` are the mutable, in-app preferences (src/db/settings.ts).
 * `deployment` is a READ-ONLY reflection of the env-resolved Config — which
 * provider is live, the From address, the origins, whether Access is configured —
 * so the editor can show what was set at deploy time and link to the setup docs
 * for how to change it. It deliberately exposes NO secrets (SPEC §8/§10): the
 * provider credentials, the Access AUD, and the dev secret never appear here.
 */

import { type AppSettings, getSettings, updateSettings } from "../db/settings";
import { badRequest, json } from "../lib/errors";
import type { RequestContext } from "../router";

/** The non-secret, deploy-time facts the editor shows read-only. */
function deploymentView(c: RequestContext) {
  const cfg = c.config;
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

export async function get(c: RequestContext): Promise<Response> {
  const settings = await getSettings(c.env.DB);
  return json({ settings, deployment: deploymentView(c) });
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
    return json({ settings });
  } catch (e) {
    // updateSettings throws plain Errors for invalid input (bad address, too many).
    throw badRequest(e instanceof Error ? e.message : "invalid settings");
  }
}

/** Pick only the known editable keys off the request body. */
function readPatch(body: unknown): Partial<AppSettings> {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};
  if ("testRecipients" in o) {
    if (!Array.isArray(o.testRecipients)) {
      throw badRequest("testRecipients must be a list");
    }
    patch.testRecipients = o.testRecipients as string[];
  }
  return patch;
}
