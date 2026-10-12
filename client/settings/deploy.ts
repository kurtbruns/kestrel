// Settings' "Set at deploy" group: the email sender and the instance's infrastructure, a
// read-only reflection of the deploy-time config that only a redeploy changes (SPEC §9).
// Secrets never come down this wire (see routes/settings.ts).

import { DEFAULT_MIN_LEAD_MS, formatLead } from "../../shared/sends";
import type { DeploymentView, SimulationProfile } from "../../shared/settings";
import { connectProviderLink } from "../deployment";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";
import { chip, monogram, type SettingsPage, secHead } from "./page";

const PROVIDER_LABELS: Record<string, string> = {
  none: "No email provider connected",
  fake: "Fake (dev, dead-end)",
  ses: "Amazon SES",
  resend: "Resend",
};

/** The provider a deployment sends through, as Settings names it. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

/**
 * The Email provider row's value: the provider's name, the simulation a local server runs
 * in its place, or, while none is connected (SPEC §9), the state and the step that ends it.
 */
function providerValue(d: DeploymentView): Html {
  if (d.provider === "none") {
    return html`${providerLabel(d.provider)}. ${connectProviderLink("set-link")} to start sending.`;
  }
  return html`${providerLabel(d.provider)}${d.simulation ? html`<span class="set-pill">Simulating ${SIMULATION_LABELS[d.simulation.profile]}${d.simulation.faults === "none" ? ", no failures" : ""}</span>` : null}`;
}

/** The provider a local send simulation models, as the Email provider row names it. */
const SIMULATION_LABELS: Record<SimulationProfile, string> = {
  generic: "a generic provider",
  resend: "Resend",
  ses: "Amazon SES",
};

function bareAddress(from: string): string {
  const m = String(from || "").match(/<([^>]+)>/);
  return m?.[1] ? m[1] : String(from || "");
}

export function senderSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  const { fromName } = page;
  return html`
    <section class="set-sec">
      ${secHead("Email sender", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("readonly")}<span>The sender is fixed at deploy via environment secrets, so it can’t be edited here. Change it in the <a class="set-link" href="#/docs">setup guide</a>, then redeploy. Credentials are never shown.</span></div>
        <div class="set-preview-bar" style="background:transparent">
          <span class="set-preview-lbl">Inbox preview</span>
          <span class="set-preview-dot">How readers see the sender</span>
        </div>
        <div class="set-inbox">
          <div class="set-inbox-avatar">${monogram(fromName, fromName)}</div>
          <div class="set-inbox-body">
            <div class="set-inbox-top"><span class="set-inbox-from">${fromName}</span><span class="set-inbox-time">9:02 AM</span></div>
            <div class="set-inbox-subj">Your latest post: a sample subject line</div>
            <div class="set-inbox-snip">The opening lines of your post show here as the inbox preview…</div>
            <div class="set-inbox-addr">${bareAddress(d.fromAddress)}</div>
          </div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono">${d.fromAddress}</span></div>
          <div class="set-kv-k">Sending domain</div><div class="set-kv-v"><span class="mono">${d.sendingDomain}</span></div>
          <div class="set-kv-k">Email provider</div><div class="set-kv-v" id="providerValue">${providerValue(d)}</div>
        </div>
      </div>
    </section>`;
}

export function instanceSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  const archiveBase = `${d.archiveOrigin || ""}${d.archiveBasePath || ""}`;
  const archiveIsDefault = d.archiveOrigin === d.appOrigin;
  return html`
    <section class="set-sec">
      ${secHead("Instance", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("info")}<span>Deploy-time infrastructure, shown for reference. These live in your Worker config and never pass through the API. See the <a class="set-link" href="#/docs/configuration">setup guide</a> to change them.</span></div>
        <div class="set-kv">
          <div class="set-kv-k">App origin</div><div class="set-kv-v"><span class="mono">${d.appOrigin}</span></div>
          <div class="set-kv-k">Archive URL base</div><div class="set-kv-v"><span class="mono">${archiveBase}</span>${archiveIsDefault ? html`<span class="set-pill">default: app origin</span>` : null}</div>
          <div class="set-kv-k">Image URL base</div><div class="set-kv-v"><span class="mono">${d.mediaPublicBase}</span></div>
          <div class="set-kv-k">Auth mode</div><div class="set-kv-v">${d.authMode === "access" ? "Cloudflare Access" : "Local dev token"}</div>
          <div class="set-kv-k">Cloudflare Access</div><div class="set-kv-v">${d.accessConfigured ? html`<span class="set-pill ok">${icon("check")}Configured</span>` : html`<span class="set-pill">Not configured</span>`}</div>
          <div class="set-kv-k">Minimum lead</div><div class="set-kv-v">${formatLead(d.minLeadMs)}${d.minLeadMs === DEFAULT_MIN_LEAD_MS ? html`<span class="set-pill">default</span>` : null}</div>
        </div>
      </div>
    </section>`;
}
