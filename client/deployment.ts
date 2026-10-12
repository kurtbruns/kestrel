// Reads of the deployment reflection (appState.appConfig.deployment; SPEC §9), fetched once
// at boot: the build reference, the archive URL, the minimum lead, and the no-provider notes.

import { archivePostUrl } from "../shared/archive_url";
import { DEFAULT_MIN_LEAD_MS, formatLead, NOT_CONNECTED_ADVICE } from "../shared/sends";
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
 * Why a picked time is refused for being too soon, in the publisher's words (SPEC §6): the
 * lead is what keeps a window to cancel in. Where the dialog offers Send now, it says that
 * is the way to the soonest send.
 */
export function tooSoonText(offersSendNow: boolean): string {
  const why = `Pick a time at least ${minLeadText()} from now, so there’s a window to cancel in.`;
  return offersSendNow ? `${why} For the soonest send, use Send now below.` : why;
}

/** Whether a picked time is inside the minimum lead, checked before asking the server. */
export function isTooSoon(fireAt: number, now = Date.now()): boolean {
  return fireAt < now + minLeadMs();
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
 * True when the deployment sends through the `fake` stand-in, which records a send but
 * never delivers: local development, the tests, or a hosted demo, each of which names it on
 * purpose (SPEC §9). This is the developer's "nothing is delivered" voice. A deployment
 * partway through setup is the other state, not connected (`providerNotConnected`). Read
 * from the read-only deployment reflection fetched once at boot; the copy avoids the
 * internal "fake transport" term (docs/DESIGN.md §4).
 */
export function noEmailProvider(): boolean {
  return appState.appConfig?.deployment.provider === "fake";
}

/**
 * True when no email provider is connected (SPEC §9): a deployment whose `PROVIDER` is not
 * set yet, which refuses every send. The operator's voice: name the state and point to the
 * step that ends it, labelled "Connect an email provider" (`connectProviderLink`).
 */
export function providerNotConnected(): boolean {
  return appState.appConfig?.deployment.provider === "none";
}

/**
 * True when this is local development's preview of the not-connected state
 * (`SIMULATE_SENDS=not-connected`, SPEC §10) rather than a deployment partway through setup,
 * as the reflection says. Its way out is a restart, not a deploy.
 */
export function notConnectedPreview(): boolean {
  return providerNotConnected() && appState.appConfig?.deployment.notConnectedPreview === true;
}

/** The setup step that connects a provider: Get started's Connect an email provider, whose first
 *  paragraph sends an SES operator to the SES guide instead. */
export const CONNECT_PROVIDER_HREF = "#/docs/resend";

/** The one link every not-connected line carries, worded for any provider. */
export function connectProviderLink(cls?: string): Html {
  const classAttr = cls ? html` class="${cls}"` : null;
  return html`<a${classAttr} href="${CONNECT_PROVIDER_HREF}">${NOT_CONNECTED_ADVICE.step}</a>`;
}

/**
 * What to do about a send held for want of a provider (SPEC §9), as a page says it: the
 * shared advice (`refusalAdvice`) with its step as the link every not-connected line
 * carries, in place of the guide's mention. In the local preview there is nothing to
 * deploy, so it names the restart that ends the state instead.
 */
export function heldAdviceHtml(): Html {
  return notConnectedPreview()
    ? html`Restart <code>npm run dev</code> without <code>SIMULATE_SENDS=not-connected</code> to send.`
    : html`${connectProviderLink()}${NOT_CONNECTED_ADVICE.after}`;
}

/**
 * The one line for sends held while no provider is connected (DESIGN §4): the state, the
 * held sends (`which`, a link to one or to the list of several), the reassurance every
 * refused send carries (SPEC §12), and the fix, once. The dashboard's health block and the
 * Sent page's attention card both say it, in place of the state's line and the send's own.
 */
export function heldSendsHtml(which: Html, count: number): Html {
  const one = count === 1;
  return html`No email provider connected, so nothing can be sent and ${which} ${one ? "is" : "are"} held, with no one marked unsent; ${one ? "it goes out at its" : "they go out at their"} first retry once one is connected. ${heldAdviceHtml()}`;
}

/**
 * A page's standing not-connected warning (DESIGN §4): the health block's amber treatment,
 * not dismissible, since the state holds every time the page is read.
 * `cls` names the surface's line; null when a provider is connected.
 */
export function notConnectedWarning(cls: string, words: Html): Html | null {
  return providerNotConnected()
    ? html`<div class="health amber ${cls}" role="status"><span class="health-dot">⚠️</span><div><span>${words}</span></div></div>`
    : null;
}

/**
 * A scheduled send's line while no provider is connected: its window is real and still
 * cancelable, so the countdown stays, but at the fire time it is held, not sent. Read from
 * the deployment reflection, not from the send, which carries no condition until it fires.
 */
export function heldWhenFiresHtml(): Html | null {
  return providerNotConnected()
    ? html`<div class="sched-held">Will be held: no email provider is connected.</div>`
    : null;
}

/**
 * The standing line a dialog carries while no provider is connected (DESIGN §4): not
 * dismissible, since the state holds every time the dialog opens, and gone
 * once a provider is set. `why` says what the state stops; `after` ends the sentence the
 * link starts. Null otherwise.
 */
function notConnectedLine(why: string, after: string): Html | null {
  return providerNotConnected()
    ? html`<p class="hint not-connected">No email provider connected, so ${why}. ${connectProviderLink()}${after}.</p>`
    : null;
}

/** The Send-a-test dialogs' standing line; their Send is disabled beside it. */
export function notConnectedTestLine(): Html | null {
  return notConnectedLine("a test can’t be sent yet", " to send one");
}

/** The Add subscriber dialog's standing line: adding sends a confirmation, so its Send
 *  confirmation is disabled beside it and the address field left out. */
export function notConnectedAddLine(): Html | null {
  return notConnectedLine("a confirmation can’t be sent yet", " to add subscribers");
}

/** The Schedule dialog's standing line; its Schedule and Send now are disabled beside it. */
export function notConnectedScheduleLine(): Html | null {
  return notConnectedLine("this can’t be scheduled yet", " to schedule it");
}

/**
 * The Reschedule dialog's line. Moving a send already scheduled is still accepted (it sends
 * nothing), so its control stays live; the line says the send is held when it fires.
 */
export function notConnectedRescheduleLine(): Html | null {
  return notConnectedLine("this send is held when it fires, until one is", " to send it");
}

/**
 * Suffix a send/test/schedule confirmation so it never reads as a real send on the `fake`
 * stand-in. Tense-neutral ("nothing is delivered") so it fits a test that already ran, a
 * send now queued, and a schedule that will fire later alike. A not-connected deployment
 * refuses those acts, so it never gets this far.
 */
export function withNoProviderNote(msg: string): string {
  return noEmailProvider() ? `${msg} (no email provider configured, so nothing is delivered)` : msg;
}

/** A post's public archive address under this deployment, by the formula the Worker
 *  uses (shared/archive_url.ts), or null before the reflection has loaded. */
export function postArchiveUrl(slug: string): string | null {
  const d = appState.appConfig?.deployment;
  return d ? archivePostUrl(d.archiveOrigin, d.archiveBasePath, slug) : null;
}
