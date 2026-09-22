// The app-wide state: the three values every view reads and boot writes, in one object
// (`appState`) so each cross-module write is visible here. What a view owns lives in the
// view, for as long as its mount (client/lifecycle.ts).

/** The boot probe's answer (GET /api/whoami): who we are and which auth mode gates this surface. */
export interface Session {
  principal: { kind: "human" | "service"; email?: string };
  auth: { mode: "access" | "dev" };
}

import type { SettingsResponse } from "../shared/settings";

export interface AppState {
  /** The dev token (local dev only; deployed envs authenticate at the edge). */
  token: string;
  /** Set once booted. */
  session: Session | null;
  /**
   * The last GET /api/settings payload, fetched at boot so the sidebar brand and the
   * dashboard's publication and setup cards can read the origins and the From-address
   * fallback without re-fetching on every render.
   */
  appConfig: SettingsResponse | null;
}

/** localStorage key of the dev token. */
export const TOKEN_KEY = "kestrel_token";

export const appState: AppState = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  session: null,
  appConfig: null,
};
