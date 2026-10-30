// The email provider's connection as the editor words it (GET /api/provider; SPEC §13): its
// read, and the lines Settings, the dashboard, and Subscribers show for the sandbox, production,
// the send rate, the server's warnings, and whether email is getting out. The state, the
// warnings, and the refusal are the server's; the editor only words the states and shows each
// warning as it comes, red for an `error` and amber for a `warn`.

import type {
  ProviderStatusView,
  ProviderWarning,
  SendingPurpose,
  SendingRefusal,
} from "../shared/provider";
import type { DeploymentView } from "../shared/settings";
import { api } from "./api";
import { type Html, html } from "./ui/html";

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

/**
 * Settings' Email provider row for SES, with `beside` (a local simulation's pill) after its name: the state as a pill and, in the sandbox, what it limits
 * and where AWS's review stands. Unknown says only "Amazon SES", as before the app could tell,
 * except when the key isn't allowed to read the account: that is a deploy fix, so the row says
 * what it would show and links the step that adds the permission. It explains, never warns,
 * since sending works either way.
 */
export function providerStateHtml(v: ProviderStatusView, beside: Html | null = null): Html {
  if (v.state === "production") {
    return html`<span>Amazon SES <span class="set-pill ok" id="providerState">Production</span>${beside}</span>`;
  }
  if (v.state !== "sandbox") {
    return v.unknown_reason === "permission"
      ? html`<span>Amazon SES${beside}</span><span class="muted" id="providerUnread">To show whether SES is in the sandbox, Kestrel’s AWS key needs permission to read your account. <a class="set-link" href="${ACCOUNT_PERMISSION_HREF}">Add the permission</a></span>`
      : html`Amazon SES${beside}`;
  }
  const pill = html`<span class="set-pill warn" id="providerState">Sandbox</span>`;
  const line =
    v.review === "pending"
      ? html`AWS is reviewing your request for production access. Until then, it mails only addresses verified in SES${daily(v)}.`
      : v.review === "denied"
        ? html`<span class="set-warn">AWS hasn’t granted production access yet. ${awsReplied(v)}: read its reply and answer there.</span> <a class="set-link" href="${AWS_QUESTIONS_HREF}">What AWS asks for</a>`
        : v.review === "failed"
          ? html`<span class="set-warn">AWS didn’t receive your request for production access.</span> <a class="set-link" href="${PRODUCTION_ACCESS_HREF}">Request it again</a>`
          : html`<span class="set-warn">It mails only addresses verified in SES${daily(v)}.</span> <a class="set-link" href="${PRODUCTION_ACCESS_HREF}">Request production access</a>`;
  return html`<span>Amazon SES ${pill}${beside}</span><span class="muted" id="providerReview">${line}</span>`;
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
};

/** A warning in the server's words, with the guide step that fixes it. */
export function warningHtml(w: ProviderWarning): Html {
  return html`${w.message} <a href="#/docs/${w.docs.slug}/${w.docs.anchor}">${WARNING_LINKS[w.code]}</a>`;
}

/** True for a warning that means no email can go out until it's fixed, which reads red. */
export const stopsSending = (w: ProviderWarning): boolean => w.severity === "error";

/** The dashboard's health line while SES is still in the sandbox. */
export function sandboxHealthHtml(): Html {
  return html`Amazon SES is still in the sandbox, so it mails only addresses verified in SES. <a href="${PRODUCTION_ACCESS_HREF}">Request production access</a>`;
}

/** The setup step's hint for production access, by where AWS's review stands. */
export function productionAccessHint(v: ProviderStatusView | null): string {
  if (v?.state === "production") {
    return "AWS granted it: SES mails anyone who signs up.";
  }
  if (v?.state === "sandbox" && v.review === "pending") {
    return "AWS is reviewing your request. Until then, SES mails only addresses verified in SES.";
  }
  if (v?.state === "sandbox" && v.review === "denied") {
    return `AWS hasn’t granted it yet. ${awsReplied(v)}: answer there.`;
  }
  if (v?.state === "sandbox" && v.review === "failed") {
    return "AWS didn’t receive your request. Ask again.";
  }
  if (v?.state === "sandbox") {
    return "SES mails only addresses verified in SES until AWS grants it. Ask once a test email has arrived.";
  }
  return "Ask once a test email has arrived. Kestrel can’t read your SES account, so the SES console’s account dashboard says whether AWS granted it.";
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

const ACCEPTED_BY: Record<SendingPurpose, string> = {
  test: "a test",
  confirmation: "a confirmation",
  list: "a post",
  notification: "a notification",
};

/**
 * Settings' line under the Email provider for whether email is getting out (SPEC §13): its
 * pill (none while working) and what it means. Null with no provider.
 */
export function sendingHtml(
  v: ProviderStatusView,
  when: (ms: number) => string,
): { pill: Html | null; line: Html } | null {
  const s = v.sending;
  if (!s) {
    return null;
  }
  const last = s.last_accepted
    ? html`<span class="muted" id="providerLastAccepted">SES last took ${ACCEPTED_BY[s.last_accepted.by]}: ${when(s.last_accepted.at)}.</span>`
    : null;
  if (s.state === "refusing" && s.refusal) {
    return {
      pill: html`<span class="set-pill danger" id="providerSending">Refusing</span>`,
      line: html`<span class="set-error">${refusalWords(s.refusal)} Then <a class="set-link" href="${TEMPLATE_TEST_HREF}">send a test email</a>.</span>${last}`,
    };
  }
  if (s.state === "unproven") {
    return {
      pill: html`<span class="set-pill" id="providerSending">Not proven yet</span>`,
      line: html`<span>SES hasn’t sent anything yet, so signups are closed. <a class="set-link" href="${TEMPLATE_TEST_HREF}">Send a test email</a></span>`,
    };
  }
  return { pill: null, line: last ?? html`` };
}
