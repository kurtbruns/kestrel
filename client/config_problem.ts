// The wall a refused deployment lands on (SPEC §9): while the Worker refuses its
// configuration, every API call answers `invalid_config` naming the variable, and while its
// database is behind the release, `schema_behind` naming the migrations and the command that
// applies them, so the editor shows that once, full page, with the fix, instead of failing
// call by call.

import { unmount } from "./lifecycle";
import { app } from "./shell";
import { $ } from "./ui/dom";
import { type Html, html, setHtml } from "./ui/html";

/** What the API says of a refused deployment: its words about it, and the variable to fix
 *  when it is a setting. A database behind the release names no variable: its words name the
 *  migrations and the command. */
export interface ConfigRefusal {
  variable?: string;
  message: string;
}

/** The refusal an error body carries, or null for any other body. */
export function configRefusal(data: unknown): ConfigRefusal | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as { error?: unknown; variable?: unknown; message?: unknown };
  if (d.error === "schema_behind" && typeof d.message === "string") {
    return { message: d.message };
  }
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

/** Each variable's heading in the Configuration reference, by its GitHub-style anchor; a
 *  secret's is the Secrets table. */
export const REFERENCE_ANCHORS: Readonly<Record<string, string>> = {
  PROVIDER: "provider",
  ALLOW_FAKE_PROVIDER: "provider",
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
  SIMULATE_SENDS: "what-the-app-refuses",
};

/** The section of the reference listing everything the app refuses, for a variable with no
 *  heading of its own. */
const REFUSALS_ANCHOR = "what-the-app-refuses";

/** The reference's address for one variable, at its own heading when it has one. */
export function referenceUrl(variable: string): string {
  return `${CONFIGURATION_REFERENCE}#${REFERENCE_ANCHORS[variable] ?? REFUSALS_ANCHOR}`;
}

/**
 * Replace the app with the explanation: the server's words about what's wrong, which name
 * the variable, and the reference, which says how to set it wherever the editor runs.
 * The how-to lives in the reference, not here, so it can't drift from it. The mounted view is torn down first, so nothing keeps calling
 * an API that can only refuse, and the publication chrome hides, as on the sign-in wall.
 * Every call in flight fails the same way, so a wall already up is left as it is.
 */
export function showConfigProblem(refusal: ConfigRefusal): void {
  if (app.querySelector(".config-wall")) {
    return;
  }
  unmount();
  document.body.classList.add("signed-out");
  const { variable } = refusal;
  // A setting links to its reference; a database behind the release has its command in the
  // server's words already, and the reference has nothing to add.
  const heading = variable ? "A setting needs fixing" : "The database needs updating";
  const reference: Html | string = variable
    ? html`<p class="hint"><a href="${referenceUrl(variable)}" target="_blank" rel="noopener">${variable} in the Configuration reference <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>`
    : "";
  setHtml(
    app,
    html`<div class="card auth-wall config-wall" role="alert"><h2 tabindex="-1">${heading}</h2><p>Kestrel won't run until it's fixed, and nothing is sent in the meantime.</p><p class="config-wall-problem">${refusal.message}</p>${reference}<button id="config-reload" class="primary">Reload</button></div>`,
  );
  $("#config-reload", app).onclick = () => location.reload();
  $<HTMLElement>(".config-wall h2", app).focus();
}
