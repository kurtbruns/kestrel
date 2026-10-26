// Auth on the client: the boot probe, the dev token, the bearer header, the identity chip,
// and the re-auth wall a dead session lands on.

import { unauthorizedReason } from "../shared/errors";
import { CLIENT_HEADER, EDITOR_CLIENT } from "../shared/who_acted";
import { showAccessLocked } from "./access_locked";
import { configRefusal, showConfigProblem } from "./config_problem";
import { unmount } from "./lifecycle";
import { app, identity } from "./shell";
import { appState, type Session, TOKEN_KEY } from "./state";
import { $ } from "./ui/dom";
import { html, setHtml } from "./ui/html";

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
 * The headers every API call carries: the editor's own name as its client (SPEC §11, Who
 * acted), and the dev token in Authorization. In Access mode there is no token and the
 * session cookie authenticates instead, so no Authorization is sent.
 */
export function authHeaders(): Record<string, string> {
  return {
    [CLIENT_HEADER]: EDITOR_CLIENT,
    ...(appState.token ? { Authorization: `Bearer ${appState.token}` } : {}),
  };
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
      html`<span class="who dev" title="Local dev: sign-in is skipped on localhost">Local dev</span>`,
    );
  }
}

/**
 * Access sessions expire at the edge (the request never reaches the app), so the only
 * recovery is a fresh document load that re-triggers the Access login. In dev this
 * shouldn't happen, but a reload re-mints, so the same affordance is safe.
 */
export function showReauth(): void {
  // Every call in flight fails the same way, so a wall already up is left as it is: drawn
  // again, it would take focus back from wherever the reader had moved it.
  if (app.querySelector(".reauth-wall")) {
    return;
  }
  // A dead token means every background poll (and a pending editor autosave) now 401s —
  // which is what routed us here. Tear the view down so a walled tab goes quiet instead of
  // re-hitting the API on its timers until reload.
  unmount();
  // No identity yet — hide the publication chrome so the wall stands alone.
  document.body.classList.add("signed-out");
  setHtml(
    app,
    html`<div class="card auth-wall reauth-wall"><h2 tabindex="-1">Session expired</h2><p class="hint">Your access session ended. Sign in again to continue.</p><button id="reauth" class="primary">Sign in</button></div>`,
  );
  $("#reauth", app).onclick = () => location.reload();
  // Focus starts on the heading, as on the other walls, so a screen reader begins there.
  $<HTMLElement>(".reauth-wall h2", app).focus();
}

// Mint a dev token into localStorage. Returns false when deployed, where the endpoint 404s
// (or is unreachable) and the Access cookie authenticates instead.
async function mintDevToken(): Promise<boolean> {
  try {
    const r = await fetch("/api/dev/token?kind=human");
    if (r.ok) {
      setToken(((await r.json()) as { token: string }).token);
      return true;
    }
  } catch {
    /* deployed: the endpoint is absent; the Access cookie authenticates instead */
  }
  return false;
}

// Probe identity. A network error or an opaque Access redirect can't be recovered here, so
// it surfaces as a null result (the sign-in wall).
async function whoami(): Promise<Response | null> {
  try {
    return await fetch("/api/whoami", { headers: authHeaders(), redirect: "manual" });
  } catch {
    return null;
  }
}

function isSession(data: unknown): data is Session {
  const d = data as Partial<Session> | null;
  return typeof d?.principal === "object" && d.principal !== null && typeof d.auth === "object";
}

/**
 * The boot probe: who is signed in, minting a dev token first in local development. Answers
 * the session, or null once it has put up the wall the probe landed on: the refused
 * configuration's when the server names a setting to fix (SPEC §9), the locked editor's when
 * the deployment has no Access yet (SPEC §11), since signing in again cannot help with
 * either, and the sign-in wall otherwise.
 */
export async function probeSession(): Promise<Session | null> {
  if (!appState.token) {
    await mintDevToken();
  }
  let res = await whoami();
  // Stale stored token in dev: clear it, mint a fresh one, and probe again so a leftover
  // credential self-heals. In Access mode the re-mint fails and `res` stays as it was.
  if (!res?.ok && appState.token) {
    setToken("");
    if (await mintDevToken()) {
      res = await whoami();
    }
  }
  // A 200 that isn't the app's JSON (a proxy's page, say) names no one, so it lands on the
  // sign-in wall below rather than leaving the page blank.
  const data: unknown = res ? await res.json().catch(() => null) : null;
  if (res?.ok && isSession(data)) {
    return data;
  }
  const refusal = configRefusal(data);
  const reason = unauthorizedReason(data);
  if (refusal) {
    showConfigProblem(refusal);
  } else if (reason) {
    showAccessLocked(reason);
  } else {
    showReauth();
  }
  return null;
}
