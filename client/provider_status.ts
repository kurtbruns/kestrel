// The email provider's connection as the editor words it (GET /api/provider; SPEC §13): its
// read, and the lines, pills, and summaries Settings, the dashboard, and Subscribers show for
// the sandbox, production, the send rate, the server's warnings, and whether email is getting out. The state, the
// warnings, and the refusal are the server's; the editor only words the states and shows each
// warning as it comes, red for an `error` and amber for a `warn`.

import type { ProviderStatusView, ProviderWarning, SendingRefusal } from "../shared/provider";
import type { DeploymentView } from "../shared/settings";
import { api } from "./api";
import { type Html, html } from "./ui/html";
import type { HealthLevel } from "./ui/widgets";

/** The setup guide's page that asks AWS for production access. */
export const PRODUCTION_ACCESS_HREF = "#/docs/production-access";

/** Its section on what to tell AWS when it replies without granting access. */
const AWS_QUESTIONS_HREF = "#/docs/production-access/3-answer-awss-questions";

/** Connect Amazon SES' step whose policy lets the app's key read the account. */
export const ACCOUNT_PERMISSION_HREF = "#/docs/ses/5-create-the-apps-aws-key";

/** The Template screen, whose Send test email is the step that proves email works. */
export const TEMPLATE_TEST_HREF = "#/template";

/** True when the deployment has a provider worth reading: SES itself, or local dev simulating one (SPEC §10). */
export function readsSesAccount(d: DeploymentView | null | undefined): boolean {
  return d?.provider === "ses" || Boolean(d?.simulation);
}

/**
 * The connection, or null when the read fails or there's nothing to read: only SES is asked,
 * or local dev's simulation of one (`SIMULATE_SENDS`, SPEC §10). A failed read leaves the page as it was before the app
 * could tell, never in an error.
 */
export async function readProviderStatus(
  deployment: DeploymentView | null | undefined,
  signal: AbortSignal,
): Promise<ProviderStatusView | null> {
  if (!readsSesAccount(deployment)) {
    return null;
  }
  try {
    return await api<ProviderStatusView>("/api/provider", { signal });
  } catch {
    return null;
  }
}

/** True while SES mails only the addresses verified with it. */
export const inSandbox = (v: ProviderStatusView | null): boolean => v?.state === "sandbox";

/** "up to 200 a day", or nothing when the account's limit is unknown or unlimited. */
function daily(v: ProviderStatusView): string {
  const n = v.account?.max_24_hour_send;
  return typeof n === "number" ? `, up to ${n.toLocaleString()} a day` : "";
}

/** Settings' Production access row: the account's state named first, so the line reads on
 *  its own without the pill, and what it means in a clause. Null while the app can't tell,
 *  except a key that isn't allowed to read the account, which is a deploy fix. */
export function accountSummaryHtml(v: ProviderStatusView): Html | null {
  if (v.state === "production") {
    return html`<span><strong>Production</strong>: SES mails anyone.</span>`;
  }
  if (v.state === "sandbox") {
    const rest =
      v.review === "pending"
        ? ", while AWS reviews your request."
        : v.review === "denied"
          ? ". AWS has replied without granting it."
          : v.review === "failed"
            ? ". AWS didn’t receive your request."
            : ": SES mails only addresses verified in it.";
    return html`<span><strong>Sandbox</strong>${rest}</span>`;
  }
  return v.unknown_reason === "permission"
    ? html`<span><strong>Unknown</strong>: Kestrel’s AWS key can’t read the account.</span>`
    : null;
}

/** The account's state as a pill in Settings' Email provider head: a fact, so grey. */
export function accountPillHtml(v: ProviderStatusView): Html | null {
  const label = v.state === "production" ? "Production" : v.state === "sandbox" ? "Sandbox" : null;
  return label ? html`<span class="set-pill" id="providerState">${label}</span>` : null;
}

/** A line above Settings' Email provider card. */
export interface ProviderLine {
  level: HealthLevel;
  body: Html;
}

/**
 * What needs a look about the connection, as lines above Settings' Email provider card,
 * worst first: red, then amber, then information with a next step, and within that what closes
 * signups before the sandbox. The refusal stands for the account check's errors, which say the
 * same cause, as on the dashboard. Nothing while all is well (DESIGN §1.3).
 */
export function providerLines(v: ProviderStatusView): ProviderLine[] {
  const red: Html[] = [];
  const amber: Html[] = [];
  const info: Html[] = [];
  const refusal = refusalOf(v);
  if (refusal) {
    red.push(notGoingOutHtml(refusal));
  }
  for (const w of v.warnings) {
    if (refusal && stopsSending(w)) {
      continue;
    }
    (stopsSending(w) ? red : amber).push(warningHtml(w));
  }
  if (v.sending?.state === "unproven") {
    info.push(
      html`SES hasn’t sent anything yet, so signups are closed. <a href="${TEMPLATE_TEST_HREF}">Send a test email</a>`,
    );
  }
  if (v.state === "sandbox") {
    if (v.review === "denied") {
      amber.push(
        html`AWS hasn’t granted production access yet. ${awsReplied(v)}: read its reply and answer there. <a href="${AWS_QUESTIONS_HREF}">What AWS asks for</a>`,
      );
    } else if (v.review === "failed") {
      amber.push(
        html`AWS didn’t receive your request for production access. <a href="${PRODUCTION_ACCESS_HREF}">Request it again</a>`,
      );
    } else if (v.review === "pending") {
      info.push(
        html`AWS is reviewing your request for production access. Until then, SES mails only addresses verified in it${daily(v)}.`,
      );
    } else {
      info.push(sandboxHealthHtml(v));
    }
  }
  if (v.state === "unknown" && v.unknown_reason === "permission") {
    info.push(
      html`To show whether SES is in the sandbox, Kestrel’s AWS key needs permission to read your account. Sending works either way. <a href="${ACCOUNT_PERMISSION_HREF}">Add the permission</a>`,
    );
  }
  return [
    ...red.map((body) => ({ level: "red" as const, body })),
    ...amber.map((body) => ({ level: "amber" as const, body })),
    ...info.map((body) => ({ level: "neutral" as const, body })),
  ];
}

/**
 * The one pill beside the account's that names the worst line below the head, by one rule:
 * red Refusing (or Needs a fix for an error that hasn't refused an email yet), amber Needs a
 * look, grey Not proven yet, or none. Never a count: the lines are right below it.
 */
export function worstPillHtml(v: ProviderStatusView, lines: ProviderLine[]): Html | null {
  const pill = (cls: string, label: string) =>
    html`<span class="set-pill${cls}" id="providerSending">${label}</span>`;
  if (refusalOf(v)) {
    return pill(" danger", "Refusing");
  }
  if (lines.some((l) => l.level === "red")) {
    return pill(" danger", "Needs a fix");
  }
  if (lines.some((l) => l.level === "amber")) {
    return pill(" warn", "Needs a look");
  }
  return v.sending?.state === "unproven" ? pill("", "Not proven yet") : null;
}

/**
 * Where AWS's reply to a request for production access is. AWS's account reads `denied` from
 * the request for more information that follows every request within seconds, as well as for a
 * final refusal, so the editor never says AWS denied it: only that AWS replied, and where.
 */
function awsReplied(v: ProviderStatusView): string {
  return v.review_case
    ? `It has replied in AWS Support, case ${v.review_case}`
    : "It has replied in AWS Support";
}

const RATE_SOURCES = {
  account: "from your SES account",
  setting: "set by SES_MAX_SEND_RATE",
  default: "Kestrel’s default",
} as const;

/** Settings' Send rate row: the pace a send keeps to, and where it comes from. Explains, never warns. */
export function sendRateHtml(v: ProviderStatusView): Html | null {
  if (!v.send_rate) {
    return null;
  }
  const { value, source } = v.send_rate;
  return html`<span>${value} ${value === 1 ? "email" : "emails"} a second${daily(v)} <span class="muted">(${RATE_SOURCES[source]})</span></span>`;
}

/** The guide step a warning's link names, by its code. */
const WARNING_LINKS: Record<ProviderWarning["code"], string> = {
  configuration_set_missing: "Send bounces and complaints to the app",
  configuration_set_paused: "Send bounces and complaints to the app",
  key_rejected: "Create the app’s AWS key",
  sending_disabled: "A problem with Amazon SES",
  sender_unverified: "Verify your sending hostname",
  account_probation: "A problem with Amazon SES",
  bounces_not_routed: "Send bounces and complaints to the app",
  receipts_not_arriving: "Why reports don’t arrive",
};

/** A warning in the server's words, with the guide step that fixes it. */
export function warningHtml(w: ProviderWarning): Html {
  return html`${w.message} <a href="#/docs/${w.docs.slug}/${w.docs.anchor}">${WARNING_LINKS[w.code]}</a>`;
}

/** True for a warning that means no email can go out until it's fixed, which reads red. */
export const stopsSending = (w: ProviderWarning): boolean => w.severity === "error";

/** The line while SES is still in the sandbox, on the dashboard and above Settings' Email
 *  provider card, which adds the day's limit when the account gives one. */
export function sandboxHealthHtml(v: ProviderStatusView | null = null): Html {
  return html`Amazon SES is still in the sandbox, so it mails only addresses verified in SES${v ? daily(v) : ""}. <a href="${PRODUCTION_ACCESS_HREF}">Request production access</a>`;
}

/**
 * The setup step's hint for production access, by where AWS's review stands, or null when
 * there's nothing to add. Never a block: before a request, it suggests naming the publication
 * first, since AWS's reviewer looks at it.
 */
export function productionAccessHint(v: ProviderStatusView | null, named: boolean): string | null {
  if (v?.state === "production") {
    return null;
  }
  if (v?.state === "sandbox" && v.review === "pending") {
    return "Waiting for AWS to grant production access.";
  }
  if (v?.state === "sandbox" && v.review === "denied") {
    return `AWS hasn’t granted it yet. ${awsReplied(v)}: answer there.`;
  }
  if (v?.state === "sandbox" && v.review === "failed") {
    return "AWS didn’t receive your request. Ask again.";
  }
  if (!named) {
    return "Name your publication first: AWS’s reviewer looks at it.";
  }
  // Only a key that isn't allowed to read the account leaves the console as the place to look.
  // A rejected key is the health block's red line, and a failed read says nothing either way.
  if (v?.state === "unknown" && v.unknown_reason === "permission") {
    return "Kestrel can’t read your SES account, so the SES console’s account dashboard says whether AWS granted it.";
  }
  return null;
}

/** The refusal while email isn't going out (SPEC §13), or null. */
export function refusalOf(v: ProviderStatusView | null): SendingRefusal | null {
  return v?.sending?.state === "refusing" ? v.sending.refusal : null;
}

/** SES's words, or the account check's finding, then what fixes it. */
function refusalWords(r: SendingRefusal): string {
  return r.found_by === "account_check"
    ? `${r.error} ${r.advice}`
    : `SES says: ${r.error.replace(/[.!?]?$/, ".")} ${r.advice}`;
}

/**
 * The dashboard's red line while email isn't going out: SES's words, the fix, and the way
 * out, a test email, which reopens signups once SES takes it. It stands for the account
 * check's errors too, so they aren't said twice.
 */
export function notGoingOutHtml(r: SendingRefusal): Html {
  return html`<span class="dash-not-going-out"><strong>Email isn’t going out, and signups are paused.</strong> ${refusalWords(r)} Then <a href="${TEMPLATE_TEST_HREF}">send a test email</a>: once SES takes one, signups reopen.</span>`;
}

/** Subscribers' red line while email isn't going out: signups are paused, and where the fix is. */
export function signupsPausedHtml(): Html {
  return html`Signups are paused: Amazon SES is refusing email, including confirmations. <a href="#/">See what to fix</a>`;
}

/** Settings' Last accepted row: when SES last took an email, in the words the setup checklist
 *  uses, or that it hasn't yet. Null with no provider. */
export function lastAcceptedHtml(v: ProviderStatusView, when: (ms: number) => string): Html | null {
  const s = v.sending;
  if (!s) {
    return null;
  }
  return s.last_accepted
    ? html`<span class="muted" id="providerLastAccepted">SES accepted an email ${when(s.last_accepted.at)}.</span>`
    : html`<span class="muted" id="providerLastAccepted">None yet.</span>`;
}

/**
 * Settings' Last report row: when SES last reported back (SPEC §13): the evidence that bounces and
 * complaints reach the app, which a test during setup should bring within minutes. Null with no
 * provider, and while nothing has been reported and SES hasn't taken an email, when there is
 * nothing to report yet. It explains, never warns: the server's `receipts_not_arriving` does that.
 */
export function lastReportHtml(v: ProviderStatusView, when: (ms: number) => string): Html | null {
  const r = v.receipts;
  if (!r || (r.last_at === null && !v.sending?.last_accepted)) {
    return null;
  }
  return r.last_at === null
    ? html`<span class="muted" id="providerLastReport">No report from SES has reached Kestrel yet.</span>`
    : html`<span class="muted" id="providerLastReport">SES last reported back ${when(r.last_at)}.</span>`;
}
