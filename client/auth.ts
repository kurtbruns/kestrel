// @ts-nocheck
// Auth on the client: the dev token, the bearer header, and the identity chip.

import { esc } from "./helpers";
import { identity } from "./shell";
import { appState, TOKEN_KEY } from "./state";

export function setToken(t) {
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
// The dev token goes in Authorization; in Access mode there is no token and the
// session cookie authenticates instead, so we send no header.
export function authHeaders() {
  return appState.token ? { Authorization: `Bearer ${appState.token}` } : {};
}

// Renders the topbar identity chip from `session`, and handles an auth failure by
// steering to the right recovery: re-login (Access) vs. re-mint (dev).
export function renderIdentity() {
  if (!identity) {
    return;
  }
  const mode = appState.session?.auth?.mode;
  const p = appState.session?.principal || {};
  if (mode === "access") {
    const who = p.email || (p.kind === "service" ? "Service token" : "Signed in");
    identity.innerHTML =
      `<span class="who" title="${esc(who)}">${esc(who)}</span>` +
      `<a class="ghost" href="/cdn-cgi/access/logout" title="Sign out">` +
      `<svg class="signout-icon" aria-hidden="true"><use href="#i-signout"/></svg>` +
      `<span class="signout-label">Sign out</span></a>`;
  } else {
    identity.innerHTML = `<span class="who dev" title="Local dev — auth is bypassed on localhost">Local dev</span>`;
  }
}
