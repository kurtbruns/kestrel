// Reads of the deployment reflection (appState.appConfig.deployment; SPEC §9), fetched once
// at boot: the build reference, the archive URL, the minimum lead, and the no-provider notes.

import { DEFAULT_MIN_LEAD_MS, formatLead } from "../shared/sends";
import { appState } from "./state";
import { type Html, html } from "./ui/html";

/** The build reference as two link fragments: the version (to its release) and the sha (to its commit). */
export interface BuildRefParts {
  version: Html;
  sha: Html;
}

/**
 * { version, sha } from the read-only deployment reflection (appConfig.deployment.build,
 * resolved at build in src/build.ts): version → its release (only when this build IS that
 * tagged release), sha → its commit, both on the repo and never getkestrel.dev. Each
 * degrades to plain text (no dead link) when there's no repo, the build isn't a release,
 * or the sha is "dev" (a local build). null until a build is known. Build metadata is
 * quiet, secondary info: roomShell pins it to the rail's bottom-left corner (and, on
 * mobile, sets it as the room's foot); it's also at GET /api/version, where a bug report
 * is filed. Never in the publisher-facing dashboard.
 */
export function buildRefParts(): BuildRefParts | null {
  const b = appState.appConfig?.deployment.build;
  if (!b?.version) {
    return null;
  }
  const version = b.tagUrl
    ? html`<a class="build-link" href="${b.tagUrl}" target="_blank" rel="noopener">v${b.version}</a>`
    : html`v${b.version}`;
  const sha = b.commitUrl
    ? html`<a class="build-link" href="${b.commitUrl}" target="_blank" rel="noopener">${b.sha}</a>`
    : html`${b.sha}`;
  return { version, sha };
}

/**
 * The deployment's minimum lead (SPEC §6), the least time between a request to send and the
 * send firing, which the server enforces on every schedule, send now, and reschedule. The
 * default until the reflection has loaded: the editor never states a lead of its own.
 */
export function minLeadMs(): number {
  return appState.appConfig?.deployment.minLeadMs ?? DEFAULT_MIN_LEAD_MS;
}

/** The minimum lead in words, "5 minutes", for the editor's hints and toasts. */
export function minLeadText(): string {
  return formatLead(minLeadMs());
}

/**
 * The earliest time a send-time picker offers: one lead out, plus the minute the picker
 * can't show (it reads to the minute) and the moment the publisher spends choosing, so the
 * time it proposes is still outside the lead when it reaches the server.
 */
export function earliestFireAt(now = Date.now()): Date {
  return new Date(now + minLeadMs() + 60_000);
}

/**
 * True when no real email provider is configured — internally the dev `fake` transport,
 * which records a send but never delivers. Read from the same read-only deployment
 * reflection the sidebar and Settings already consume (appConfig.deployment), fetched
 * once at boot. Dev-only by construction: deployed environments require SES/Resend, so
 * this is structurally absent in production. The user-facing copy avoids the internal
 * "fake transport" term (see docs/DESIGN.md §2).
 */
export function noEmailProvider(): boolean {
  return (appState.appConfig?.deployment.provider || "") === "fake";
}

/**
 * Suffix a send/test/schedule confirmation so it never reads as a real send when no
 * provider is set up. Tense-neutral ("nothing is delivered") so it fits a test that
 * already ran, a send now queued, and a schedule that will fire later alike.
 */
export function withNoProviderNote(msg: string): string {
  return noEmailProvider() ? `${msg} (no email provider configured — nothing is delivered)` : msg;
}
