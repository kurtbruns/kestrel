// The wall a deployment with no Access lands on (SPEC §11): until Access is set up, no
// request can authenticate, and the API's 401 says so, so the editor shows that state, full
// page, with the guide that sets Access up, instead of a session that never existed.

import { unmount } from "./lifecycle";
import { app } from "./shell";
import { $ } from "./ui/dom";
import { html, setHtml } from "./ui/html";

/**
 * The published Access guide. The editor's own Docs tab is read from the API, which is
 * refusing every call until Access is set up, so the wall links to the project's site.
 */
export const ACCESS_GUIDE = "https://getkestrel.dev/docs/access/";

/** Whether a 401's body says no Access is configured, rather than this request failing it. */
export function accessNotConfigured(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const d = data as { error?: unknown; reason?: unknown };
  return d.error === "unauthorized" && d.reason === "access_not_configured";
}

/**
 * Replace the app with the explanation: the editor is locked until Access is set up, why,
 * and the guide that does it. The mounted view is torn down first, so nothing keeps calling
 * an API that can only refuse, and the publication chrome hides, as on the sign-in wall.
 * Every call in flight fails the same way, so a wall already up is left as it is.
 */
export function showAccessLocked(): void {
  if (app.querySelector(".access-wall")) {
    return;
  }
  unmount();
  document.body.classList.add("signed-out");
  setHtml(
    app,
    html`<div class="card auth-wall access-wall"><h2 tabindex="-1">The editor is locked until you set up Access</h2><p>Until Cloudflare Access is in front of the editor, the app can't tell who is asking, so it lets no one in. On a new deployment, that's expected. Your public pages work as usual.</p><p class="hint"><a href="${ACCESS_GUIDE}" target="_blank" rel="noopener">Lock the dashboard with Access <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p><button id="access-reload" class="primary">Reload</button></div>`,
  );
  $("#access-reload", app).onclick = () => location.reload();
  $<HTMLElement>(".access-wall h2", app).focus();
}
