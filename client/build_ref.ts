// Cross-view helpers over the deployment reflection: the build reference, new-post
// creation, copy, the archive URL, the no-provider notes, and re-auth.

import { archivePostUrl } from "../shared/archive_url";
import type { PostSavedResponse } from "../shared/posts";
import type { DeploymentView } from "../shared/settings";
import { api } from "./api";
import { toast } from "./helpers";
import { type Html, html, setHtml } from "./html";
import { busy } from "./notice";
import { stopPollers } from "./savebar";
import { app } from "./shell";
import { appState } from "./state";
import { clearAutosaveTimers } from "./views/editor";

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
 * Create a draft and jump into the editor — shared by the Posts list, the Dashboard,
 * and the setup checklist so the "New post" affordance behaves identically everywhere.
 */
export function createNewPost(btn: HTMLButtonElement): Promise<void> {
  return busy(btn, "Creating…", async () => {
    try {
      const { post } = await api<PostSavedResponse>("/posts", {
        method: "POST",
        json: { subject: "Untitled" },
      });
      location.hash = `#/edit/${post.id}`;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy to clipboard");
  }
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

/**
 * Access sessions expire at the edge (the request never reaches the app), so the only
 * recovery is a fresh document load that re-triggers the Access login. In dev this
 * shouldn't happen, but a reload re-mints, so the same affordance is safe.
 */
export function showReauth(): void {
  // A dead token means every background poll (and a pending editor autosave) now 401s —
  // which is what routed us here. Stop them so a walled tab goes quiet instead of re-hitting
  // the API on its timers until reload.
  stopPollers();
  clearAutosaveTimers();
  // No identity yet — hide the publication chrome so the wall stands alone.
  document.body.classList.add("signed-out");
  setHtml(
    app,
    html`<div class="card auth-wall"><h2>Session expired</h2><p class="hint">Your access session ended. Sign in again to continue.</p><button id="reauth">Sign in</button></div>`,
  );
  const b = document.getElementById("reauth");
  if (b) {
    b.onclick = () => location.reload();
  }
}
