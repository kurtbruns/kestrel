// Kestrel editor — a small vanilla SPA over the same HTTP API Claude uses.
// Auth is edge-centric: in production Cloudflare Access gates this surface, so the
// browser's Access session cookie authenticates every same-origin call and there is
// nothing to paste. In local dev there is no edge, so the editor mints a dev token
// on boot (/api/dev/token) and sends it as a bearer. Either way the boot probe
// (/api/whoami) tells us who we are and which mode we're in; the identity chip and
// the failure handling follow from that.

import type { SettingsResponse } from "../shared/settings";
import { api } from "./api";
import { probeSession, renderIdentity } from "./auth";
import { renderSidebarBrand } from "./brand";
import { startDevReload } from "./dev_reload";
import { installRoomBar } from "./room/shell";
import { adoptLinkedRoute, installRouter, route } from "./router";
import { installShell } from "./shell";
import { appState } from "./state";
import { installTooltips } from "./ui/widgets";

async function boot(): Promise<unknown> {
  // Wire the app before anything asynchronous, in one visible sequence: no module does
  // anything at load but define things, so what the app does at boot is read from here.
  installShell();
  installTooltips();
  installRoomBar();
  installRouter();
  const session = await probeSession();
  if (session) {
    appState.session = session;
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
    // A link from a notification email names its page in the query, which survives an
    // Access login where a hash would not.
    adoptLinkedRoute();
    return route();
  }
  // probeSession has already put up the wall it landed on.
  return undefined;
}
boot();
