// Auth on the client: the dev token, the bearer header, the identity chip, and the
// re-auth wall a dead session lands on.

import { $ } from "./dom";
import { html, setHtml } from "./html";
import { app, identity } from "./shell";
import { appState, stopTimers, TOKEN_KEY } from "./state";

/** Remember the dev token; an empty one forgets it, so the next boot mints instead of probing with a dead value. */
export function setToken(t: string | null | undefined): void {
  appState.token = (t || "").trim();
  try {
    // Clearing (empty token) removes the key rather than storing "", so the next
    // boot takes the "no token → mint" path instead of probing with a dead value.
    if (appState.token) {
      localStorage.setItem(TOKEN_KEY, appState.token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* private mode */
  }
}

/**
 * The dev token goes in Authorization; in Access mode there is no token and the session
 * cookie authenticates instead, so no header is sent.
 */
export function authHeaders(): Record<string, string> {
  return appState.token ? { Authorization: `Bearer ${appState.token}` } : {};
}

/**
 * Render the sidebar identity chip from the session: who is signed in under Access, with
 * the sign-out link, or the local-dev marker when there is no edge.
 */
export function renderIdentity(): void {
  const session = appState.session;
  if (session?.auth.mode === "access") {
    const p = session.principal;
    const who = p.email || (p.kind === "service" ? "Service token" : "Signed in");
    setHtml(
      identity,
      html`<span class="who" title="${who}">${who}</span><a class="ghost" href="/cdn-cgi/access/logout" title="Sign out"><svg class="signout-icon" aria-hidden="true"><use href="#i-signout"/></svg><span class="signout-label">Sign out</span></a>`,
    );
  } else {
    setHtml(
      identity,
      html`<span class="who dev" title="Local dev — auth is bypassed on localhost">Local dev</span>`,
    );
  }
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
  stopTimers();
  // No identity yet — hide the publication chrome so the wall stands alone.
  document.body.classList.add("signed-out");
  setHtml(
    app,
    html`<div class="card auth-wall"><h2>Session expired</h2><p class="hint">Your access session ended. Sign in again to continue.</p><button id="reauth">Sign in</button></div>`,
  );
  $("#reauth", app).onclick = () => location.reload();
}
