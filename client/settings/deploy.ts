// Settings' "Set at deploy" group: the email provider and the deployment's infrastructure, a
// read-only reflection of the deploy-time config that only a redeploy changes (SPEC §9), with
// what the app last read of the provider's account beside it (SPEC §13). Secrets never come
// down this wire (see routes/settings.ts).

import type { ProviderStatusView } from "../../shared/provider";
import { DEFAULT_MIN_LEAD_MS, formatLead } from "../../shared/sends";
import type { DeploymentView, SimulationProfile, SimulationView } from "../../shared/settings";
import { connectProviderLink } from "../deployment";
import {
  accountPillHtml,
  accountSummaryHtml,
  lastAcceptedHtml,
  lastReportHtml,
  providerLines,
  sendRateHtml,
  worstPillHtml,
} from "../provider_status";
import { timeAt } from "../time_zone";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";
import { healthLineHtml } from "../ui/widgets";
import { chip, type SettingsPage, secHead } from "./page";

const PROVIDER_LABELS: Record<string, string> = {
  none: "No email provider connected",
  fake: "Fake (dev, dead-end)",
  ses: "Amazon SES",
};

/** The provider a deployment sends through, as Settings names it. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

/** The provider a local send simulation models, as the Provider row names it. */
const SIMULATION_LABELS: Record<SimulationProfile, string> = {
  generic: "A generic provider",
  ses: "Amazon SES",
};

/** The Provider row: the provider's name, or the one a local server simulates in its place. */
function providerName(d: DeploymentView): string {
  return d.simulation
    ? `${SIMULATION_LABELS[d.simulation.profile]}, simulated`
    : providerLabel(d.provider);
}

/** What a local server simulates (SPEC §10), as the band across the card's top says it: the
 *  provider, a clean run when it injects no failures, and the account it stands in for. */
function simulationBandHtml(sim: SimulationView): Html {
  const what = SIMULATION_LABELS[sim.profile];
  const clean = sim.faults === "none" ? ", with no failures" : "";
  const account = sim.account
    ? html` and its account, in <strong>${sim.account.state}</strong>`
    : null;
  return html`<div class="set-dev-band" id="providerSimulation">${icon("code")}<span><strong>Local development.</strong> Simulating ${what}${clean}${account}. No email leaves this machine.</span></div>`;
}

// The setup guide's step that gives the From address an inbox. The app never receives mail
// and can't see whether that step was done, so Settings only points to it (SPEC §9).
const REPLIES_HREF = "#/docs/ses/8-receive-replies-at-your-from-address";

/** The From address row: the deploy value as written, where readers' replies go, and, when a
 *  name was written in with the address, why that name is every email's sender (SPEC §9). */
function fromAddressHtml(page: SettingsPage): Html {
  const d = page.data.deployment;
  const named = page.fromOverride
    ? html`<span class="muted" id="fromOverrideNote">“${page.fromOverride}” is written into the From address at deploy, so it is the sender whatever the publication is called. To send under your publication’s name, leave it out of the address (<a class="set-link" href="#/docs/configuration">setup guide</a>), then redeploy.</span>`
    : null;
  return html`<span class="mono">${d.from_address}</span>${named}<span class="muted" id="replyNote">Readers’ replies go to this address. <a class="set-link" href="${REPLIES_HREF}">Forward it to your inbox</a>.</span>`;
}

/** A row of the card's facts. */
const row = (label: string, value: Html, id?: string): Html =>
  html`<div class="set-kv-k">${label}</div><div class="set-kv-v set-kv-stack"${id ? html` id="${id}"` : null}>${value}</div>`;

/**
 * Email provider (SPEC §13): the account's state as a grey pill in the head and one more pill
 * naming the worst line below it; the lines that need a look between the head and the card,
 * worst first; and the card's facts, each row readable on its own.
 */
export function providerSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  // The account's read, except local dev's stand-in, which has no account to read.
  const status: ProviderStatusView | null =
    page.provider && page.provider.unknown_reason !== "stand_in" ? page.provider : null;
  const sending = page.provider;
  const lines = status ? providerLines(status) : [];
  if (d.provider === "none") {
    lines.push({
      level: "neutral",
      body: html`No email provider connected, so nothing can be sent and signups aren’t open. ${connectProviderLink()} to start sending.`,
    });
  }
  const pills =
    d.provider === "none"
      ? html`<span class="set-pill" id="providerState">Not connected</span>`
      : status
        ? html`${accountPillHtml(status)}${worstPillHtml(status, lines)}`
        : null;
  const summary = status ? accountSummaryHtml(status) : null;
  const accepted = sending ? lastAcceptedHtml(sending, timeAt) : null;
  const report = sending ? lastReportHtml(sending, timeAt) : null;
  const rate = sending ? sendRateHtml(sending) : null;
  const read = sending
    ? " The rest is what Kestrel last read from the provider, about every ten minutes and after every email."
    : "";
  return html`
    <section class="set-sec">
      ${secHead("email-sender", chip("readonly", "Read-only · set at deploy"), pills)}
      ${lines.length ? html`<div class="set-lines" id="providerLines">${lines.map((l) => healthLineHtml(l.level, l.body))}</div>` : null}
      <div class="set-card sunken">
        ${d.simulation ? simulationBandHtml(d.simulation) : null}
        <div class="set-kv">
          ${row("Provider", html`${d.provider === "none" ? "None" : providerName(d)}`, "providerValue")}
          ${summary ? row("Production access", summary, "providerAccess") : null}
          ${accepted ? row("Last accepted", accepted) : null}
          ${report ? row("Last report", report) : null}
          ${row("From address", fromAddressHtml(page))}
          ${row("Sending domain", html`<span class="mono">${d.sending_domain}</span>`)}
          ${rate ? row("Send rate", rate, "sendRate") : null}
        </div>
        <div class="set-note">${icon("readonly")}<span>The provider, its keys, the From address, and the sending domain are set at deploy in <code>wrangler.jsonc</code>, with the keys stored as secrets, so none can be edited here and credentials are never shown. See the <a class="set-link" href="#/docs/configuration">setup guide</a> to change them.${read}</span></div>
      </div>
    </section>`;
}

/** Deployment: the deploy-time infrastructure, for reference. */
export function deploymentSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  const archiveBase = `${d.archive_origin || ""}${d.archive_base_path || ""}`;
  const archiveIsDefault = d.archive_origin === d.app_origin;
  return html`
    <section class="set-sec">
      ${secHead("instance", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("info")}<span>Deploy-time infrastructure, shown for reference. These live in your Worker config and never pass through the API. See the <a class="set-link" href="#/docs/configuration">setup guide</a> to change them.</span></div>
        <div class="set-kv">
          <div class="set-kv-k">App origin</div><div class="set-kv-v"><span class="mono">${d.app_origin}</span></div>
          <div class="set-kv-k">Archive URL base</div><div class="set-kv-v"><span class="mono">${archiveBase}</span>${archiveIsDefault ? html`<span class="set-pill">default: app origin</span>` : null}</div>
          <div class="set-kv-k">Image URL base</div><div class="set-kv-v"><span class="mono">${d.media_public_base}</span></div>
          <div class="set-kv-k">Auth mode</div><div class="set-kv-v">${d.auth_mode === "access" ? "Cloudflare Access" : "Local dev token"}</div>
          <div class="set-kv-k">Cloudflare Access</div><div class="set-kv-v">${d.access_configured ? html`<span class="set-pill ok">${icon("check")}Configured</span>` : html`<span class="set-pill">Not configured</span>`}</div>
          <div class="set-kv-k">Minimum lead</div><div class="set-kv-v">${formatLead(d.min_lead_ms)}${d.min_lead_ms === DEFAULT_MIN_LEAD_MS ? html`<span class="set-pill">default</span>` : null}</div>
        </div>
      </div>
    </section>`;
}
