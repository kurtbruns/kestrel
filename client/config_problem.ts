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

/** Each variable's heading in the Configuration reference, by its GitHub-style anchor. */
export const REFERENCE_ANCHORS: Readonly<Record<string, string>> = {
  PROVIDER: "email-provider",
  ALLOW_FAKE_PROVIDER: "email-provider",
  APP_ORIGIN: "app-address",
  AWS_REGION: "ses-region",
  FROM_ADDRESS: "from-address-and-sending-domain",
  SENDING_DOMAIN: "from-address-and-sending-domain",
  ARCHIVE_BASE_PATH: "archive-path",
  SES_MAX_SEND_RATE: "send-rate",
  SUBREQUEST_BUDGET: "request-budget",
  MIN_LEAD_SECONDS: "minimum-lead",
  ARCHIVE_ORIGIN: "archive-and-image-addresses",
  MEDIA_PUBLIC_BASE: "archive-and-image-addresses",
  NOTIFY_FROM: "notifications-sender",
  ACCESS_TEAM_DOMAIN: "access-team-domain-and-audience-tag",
  ACCESS_AUD: "access-team-domain-and-audience-tag",
  ACCESS_ALLOWED_EMAILS: "allowed-emails",
  AWS_ACCESS_KEY_ID: "aws-access-key",
  AWS_SECRET_ACCESS_KEY: "aws-access-key",
  SNS_TOPIC_ARN: "sns-topic",
  SES_CONFIGURATION_SET: "configuration-set",
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
    html`<div class="card auth-wall config-wall" role="alert"><h2 tabindex="-1">${heading}</h2><p>Kestrel won’t run until it’s fixed, and nothing is sent in the meantime.</p><p class="config-wall-problem">${refusal.message}</p>${reference}<button id="config-reload" class="primary">Reload</button></div>`,
  );
  $("#config-reload", app).onclick = () => location.reload();
  $<HTMLElement>(".config-wall h2", app).focus();
}
