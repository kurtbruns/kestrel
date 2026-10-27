// The email provider's connection as the editor words it (GET /api/provider; SPEC §9): its
// read, and the lines Settings and the dashboard show for the sandbox, production, the send
// rate, and the server's warnings. The state and the warnings are the server's; the editor only
// words the three states and shows each warning as it comes.

import type { ProviderStatusView, ProviderWarning } from "../shared/provider";
import type { DeploymentView } from "../shared/settings";
import { api } from "./api";
import { type Html, html } from "./ui/html";

/** The setup guide's page that asks AWS for production access. */
export const PRODUCTION_ACCESS_HREF = "#/docs/production-access";

/** Its section on what to tell AWS when it asks for more, or denies a request. */
const AWS_QUESTIONS_HREF = "#/docs/production-access/3-answer-awss-questions";

/** Connect Amazon SES' step whose policy lets the app's key read the account. */
export const ACCOUNT_PERMISSION_HREF = "#/docs/ses/5-create-the-apps-aws-key";

/** True when the deployment has an SES account to read: SES itself, or local dev standing in for one. */
export function readsSesAccount(d: DeploymentView | null | undefined): boolean {
  return d?.provider === "ses" || Boolean(d?.simulation?.account);
}

/**
 * The connection, or null when the read fails or there's nothing to read: only SES has an
 * account, so another provider is never asked, unless local dev stands in for one
 * (`SIMULATE_ACCOUNT`, SPEC §10). A failed read leaves the page as it was before the app
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
        ? html`<span class="set-warn">AWS denied production access.${v.review_case ? ` Its reply is in AWS Support, case ${v.review_case}.` : ""}</span> <a class="set-link" href="${AWS_QUESTIONS_HREF}">What AWS asks for</a>`
        : v.review === "failed"
          ? html`<span class="set-warn">AWS didn’t receive your request for production access.</span> <a class="set-link" href="${PRODUCTION_ACCESS_HREF}">Request it again</a>`
          : html`<span class="set-warn">It mails only addresses verified in SES${daily(v)}.</span> <a class="set-link" href="${PRODUCTION_ACCESS_HREF}">Request production access</a>`;
  return html`<span>Amazon SES ${pill}${beside}</span><span class="muted" id="providerReview">${line}</span>`;
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
  bounces_not_routed: "Send bounces and complaints to the app",
};

/** A warning in the server's words, with the guide step that fixes it. */
export function warningHtml(w: ProviderWarning): Html {
  return html`${w.message} <a href="#/docs/${w.docs.slug}/${w.docs.anchor}">${WARNING_LINKS[w.code]}</a>`;
}

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
    return v.review_case
      ? `AWS denied it. Its reply is in AWS Support, case ${v.review_case}.`
      : "AWS denied it. Its reply is in AWS Support.";
  }
  if (v?.state === "sandbox" && v.review === "failed") {
    return "AWS didn’t receive your request. Ask again.";
  }
  if (v?.state === "sandbox") {
    return "SES mails only addresses verified in SES until AWS grants it. Ask once a test email has arrived.";
  }
  return "Ask once a test email has arrived. Kestrel can’t read your SES account, so the SES console’s account dashboard says whether AWS granted it.";
}
