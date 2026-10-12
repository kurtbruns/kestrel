// The wall a refused deploy configuration lands on (SPEC §9): while the Worker refuses its
// configuration, every API call answers `invalid_config` naming the variable, so the editor
// shows that once, full page, with what to fix, instead of failing call by call.

import { unmount } from "./lifecycle";
import { app } from "./shell";
import { $ } from "./ui/dom";
import { html, setHtml } from "./ui/html";

/** What the API says of a refused configuration: the variable, and its words about it. */
export interface ConfigRefusal {
  variable: string;
  message: string;
}

/** The refusal an error body carries, or null for any other body. */
export function configRefusal(data: unknown): ConfigRefusal | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as { error?: unknown; variable?: unknown; message?: unknown };
  if (d.error !== "invalid_config" || typeof d.variable !== "string") {
    return null;
  }
  return {
    variable: d.variable,
    message: typeof d.message === "string" ? d.message : `${d.variable} is refused`,
  };
}

/**
 * The published Configuration reference. The editor's own Docs tab is read from the API,
 * which is refusing every call until the configuration is fixed, so the wall links to the
 * project's site instead.
 */
export const CONFIGURATION_REFERENCE = "https://getkestrel.dev/docs/configuration/";

/** Each variable's heading in the Configuration reference, by its GitHub-style anchor. A
 *  secret's is the Secrets table, which is also how the wall tells a secret from a var. */
export const REFERENCE_ANCHORS: Readonly<Record<string, string>> = {
  PROVIDER: "provider",
  APP_ORIGIN: "vars",
  AWS_REGION: "vars",
  FROM_ADDRESS: "from_address-and-sending_domain",
  SENDING_DOMAIN: "from_address-and-sending_domain",
  ARCHIVE_BASE_PATH: "archive_base_path",
  SES_MAX_SEND_RATE: "ses_max_send_rate",
  SUBREQUEST_BUDGET: "subrequest_budget",
  MIN_LEAD_SECONDS: "min_lead_seconds",
  ARCHIVE_ORIGIN: "archive_origin-and-media_public_base",
  MEDIA_PUBLIC_BASE: "archive_origin-and-media_public_base",
  NOTIFY_FROM: "notify_from",
  ACCESS_TEAM_DOMAIN: "secrets",
  ACCESS_AUD: "secrets",
  ACCESS_ALLOWED_EMAILS: "secrets",
  RESEND_API_KEY: "secrets",
  RESEND_WEBHOOK_SECRET: "secrets",
  AWS_ACCESS_KEY_ID: "secrets",
  AWS_SECRET_ACCESS_KEY: "secrets",
  SNS_TOPIC_ARN: "secrets",
  SES_CONFIGURATION_SET: "secrets",
};

/** The section of the reference listing everything the app refuses, for a variable with no
 *  heading of its own. */
const REFUSALS_ANCHOR = "what-the-app-refuses";

/** The reference's address for one variable, at its own heading when it has one. */
export function referenceUrl(variable: string): string {
  return `${CONFIGURATION_REFERENCE}#${REFERENCE_ANCHORS[variable] ?? REFUSALS_ANCHOR}`;
}

/**
 * Replace the app with the explanation: the variable, the server's words about it, how to
 * fix it, and the reference. The mounted view is torn down first, so nothing keeps calling
 * an API that can only refuse, and the publication chrome hides, as on the sign-in wall.
 */
export function showConfigProblem(refusal: ConfigRefusal): void {
  unmount();
  document.body.classList.add("signed-out");
  const secret = REFERENCE_ANCHORS[refusal.variable] === "secrets";
  const fix = secret
    ? html`It's a secret: store it with <code>npx wrangler secret put ${refusal.variable} --env production</code>, naming your environment. A secret takes effect as soon as you store it.`
    : html`Fix it in your environment's block in <code>wrangler.jsonc</code>, then deploy again.`;
  setHtml(
    app,
    html`<div class="card auth-wall config-wall" role="alert"><h2>The configuration needs a fix</h2><p>Kestrel is refusing this deployment's configuration, so nothing works and nothing is sent until it's fixed. Readers see a page saying the newsletter is temporarily unavailable.</p><p class="config-wall-problem"><code>${refusal.variable}</code>: ${refusal.message}</p><p class="hint">${fix} Then reload this page.</p><p class="hint"><a href="${referenceUrl(refusal.variable)}" target="_blank" rel="noopener">${refusal.variable} in the Configuration reference ↗</a>. It's on the project's site, since the editor's own Docs can't load until the configuration is fixed.</p><button id="config-reload" class="primary">Reload</button></div>`,
  );
  $("#config-reload", app).onclick = () => location.reload();
}
