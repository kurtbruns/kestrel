// Kestrel editor — a small vanilla SPA over the same HTTP API Claude uses.
// Auth is edge-centric: in production Cloudflare Access gates this surface, so the
// browser's Access session cookie authenticates every same-origin call and there is
// nothing to paste. In local dev there is no edge, so the editor mints a dev token
// on boot (/api/dev/token) and sends it as a bearer. Either way the boot probe
// (/api/whoami) tells us who we are and which mode we're in; the identity chip and
// the failure handling follow from that.

import type { SettingsResponse } from "../shared/settings";
import { api } from "./api";
import { authHeaders, renderIdentity, setToken, showReauth } from "./auth";
import { renderSidebarBrand } from "./brand";
import { startDevReload } from "./dev_reload";
import { installRoomBar } from "./room";
import { installRouter, route } from "./router";
import { installShell } from "./shell";
import { appState, type Session } from "./state";
import { installTooltips } from "./widgets";

async function boot(): Promise<unknown> {
  // Wire the app before anything asynchronous, in one visible sequence: no module does
  // anything at load but define things, so what the app does at boot is read from here.
  installShell();
  installTooltips();
  installRoomBar();
  installRouter();
  // Mint a dev token into localStorage. Returns false in prod, where the endpoint
  // 404s (or is unreachable) and the Access cookie authenticates instead.
  async function mintDevToken(): Promise<boolean> {
    try {
      const r = await fetch("/api/dev/token?kind=human");
      if (r.ok) {
        setToken(((await r.json()) as { token: string }).token);
        return true;
      }
    } catch {
      /* prod: endpoint is absent; the Access cookie authenticates instead */
    }
    return false;
  }
  // Probe identity. A network error or an opaque Access redirect can't be recovered
  // here, so surface it as a null result (→ re-login screen).
  async function whoami(): Promise<Response | null> {
    try {
      return await fetch("/api/whoami", { headers: authHeaders(), redirect: "manual" });
    } catch {
      return null;
    }
  }

  if (!appState.token) {
    await mintDevToken();
  }
  let res = await whoami();
  // Stale stored token in dev: clear it, mint a fresh one, and probe again so a
  // leftover credential self-heals. In Access mode the re-mint fails, `res` stays
  // unauthorized, and we drop through to showReauth() below.
  if (!res?.ok && appState.token) {
    setToken("");
    if (await mintDevToken()) {
      res = await whoami();
    }
  }
  if (res?.ok) {
    appState.session = (await res.json()) as Session;
    document.body.classList.remove("signed-out");
    renderIdentity();
    // Load the publication identity for the sidebar brand. Non-fatal: on failure the
    // brand keeps its "Kestrel" placeholder and routing still proceeds.
    try {
      appState.appConfig = await api<SettingsResponse>("/api/settings");
    } catch {
      /* keep the placeholder brand */
    }
    renderSidebarBrand();
    // Dev flavor only: pick up a rebuilt bundle or an edited stylesheet without a hand
    // refresh. The production flavor compiles this out (see scripts/build-client.mjs).
    if (__DEV__) {
      startDevReload();
    }
    return route();
  }
  // opaque redirect (edge login bounce) or a clean 401 with no way to recover here.
  return showReauth();
}
boot();
