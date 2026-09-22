// Reads of the deployment reflection (appState.appConfig.deployment; SPEC §9), fetched once
// at boot: the build reference, the archive URL, and the no-provider notes.

import { archivePostUrl } from "../shared/archive_url";
import type { DeploymentView } from "../shared/settings";
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
 * The canonical archive URL for a slug, from the read-only deployment reflection; the
 * formula is the Worker's own (shared/), only the fallbacks are the editor's: this origin
 * and no base path when the reflection hasn't loaded.
 */
export function archiveUrlFor(deployment: DeploymentView | null | undefined, slug: string): string {
  return archivePostUrl(
    deployment?.archiveOrigin || location.origin,
    deployment?.archiveBasePath || "",
    slug,
  );
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
