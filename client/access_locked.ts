// The walls an Access 401 that signing in again can't fix lands on (SPEC §11): a deployment
// with no Access, where no request can authenticate until it is set up, and an Access login
// that names neither a person nor a service token, which the app refuses. The API's 401 says
// which, so the editor shows that state, full page, with the guide that sets Access up,
// instead of a session that never existed.

import type { UnauthorizedReason } from "../shared/errors";
import { unmount } from "./lifecycle";
import { app } from "./shell";
import { $ } from "./ui/dom";
import { html, setHtml } from "./ui/html";

/**
 * The published Access guide. The editor's own Docs tab is read from the API, which is
 * refusing every call, so the wall links to the project's site.
 */
export const ACCESS_GUIDE = "https://getkestrel.dev/docs/access/";

/** Where Access ends its session, so the next visit signs in afresh, perhaps another way. */
export const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

/**
 * Replace the app with the explanation for `reason`: why the editor is locked, and the guide
 * that fixes it. The mounted view is torn down first, so nothing keeps calling an API that
 * can only refuse, and the publication chrome hides, as on the sign-in wall. Every call in
 * flight fails the same way, so a wall already up is left as it is.
 */
export function showAccessLocked(reason: UnauthorizedReason): void {
  if (app.querySelector(".access-wall")) {
    return;
  }
  unmount();
  document.body.classList.add("signed-out");
  const guide = html`<p class="hint"><a href="${ACCESS_GUIDE}" target="_blank" rel="noopener">Lock the dashboard with Access <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>`;
  if (reason === "access_unidentified") {
    // Not expected, unlike a new deployment's wall: a policy needs changing, so it alerts.
    setHtml(
      app,
      html`<div class="card auth-wall access-wall" role="alert"><h2 tabindex="-1">Access let you in, but didn’t say who you are</h2><p>Cloudflare Access sent neither an email address nor a service token, and Kestrel needs one of them to tell who is asking, so it doesn’t let this sign-in in. Some other kind of Access policy, or a login method that gives no email, let it through.</p><p>Kestrel accepts two kinds of Access policy: an Allow policy on people’s emails, and a Service Auth policy on a service token. Sign out, then sign in through one of them.</p>${guide}<button id="access-signout" class="primary">Sign out</button></div>`,
    );
    $("#access-signout", app).onclick = () => location.assign(ACCESS_LOGOUT);
  } else {
    setHtml(
      app,
      html`<div class="card auth-wall access-wall"><h2 tabindex="-1">The editor is locked until you set up Access</h2><p>Until Cloudflare Access is in front of the editor, the app can’t tell who is asking, so it lets no one in. On a new deployment, that’s expected. Your public pages work as usual.</p>${guide}<button id="access-reload" class="primary">Reload</button></div>`,
    );
    $("#access-reload", app).onclick = () => location.reload();
  }
  $<HTMLElement>(".access-wall h2", app).focus();
}
