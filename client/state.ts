// The editor's module-scope state: every value more than one module reads or writes, in one
// object (`appState`) so each cross-module write is visible here. The view lifecycle work
// dissolves most of this into per-view state; until then this is the whole shared surface.

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
  /** Countdown interval on the sent list, cleared on navigation. */
  statusTimer: number | null;
  /** Freshness poll while the editor is open, cleared on navigation. */
  editorPollTimer: number | null;
  /** Live in-flight /progress poll (watch view + active-send widget), cleared on navigation. */
  progressTimer: number | null;
  /**
   * Bumped on every navigation (route()). The recursive-setTimeout pollers (sends, the sent
   * record, the dashboard) capture it when they schedule and bail after their await if it
   * changed: clearing progressTimer stops the *next* tick, but a poll whose fetch is already
   * in flight when the user navigates would otherwise resolve afterward and repaint (or swap)
   * the view they just opened, and clobber that new view's own poll timer. The generation
   * check is the guard that in-flight poll can't.
   */
  navGeneration: number;
  // Current-editor state, reset on navigation; the mounted editor re-establishes it.
  /** Has unsaved edits; drives the nav guards. */
  isEditorDirty: boolean;
  /** The last save errored, so the leave guard prompts instead of silently flushing. */
  editorSaveFailed: boolean;
  /** The draft changed elsewhere (out-of-date banner up); like a save failure, the leave guard prompts. */
  editorConflict: boolean;
  /** Hash the editor is mounted at, so the leave guard knows where to return. */
  editorHash: string | null;
  /** Save-and-go on SPA navigation away from a dirty editor. */
  editorLeaveFlush: (() => void) | null;
  /** ⌘S / Ctrl-S handler for the mounted editor. */
  editorManualSave: (() => void) | null;
}

/** localStorage key of the dev token. */
export const TOKEN_KEY = "kestrel_token";

export const appState: AppState = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  session: null,
  appConfig: null,
  statusTimer: null,
  editorPollTimer: null,
  progressTimer: null,
  navGeneration: 0,
  isEditorDirty: false,
  editorSaveFailed: false,
  editorConflict: false,
  editorHash: null,
  editorLeaveFlush: null,
  editorManualSave: null,
};
