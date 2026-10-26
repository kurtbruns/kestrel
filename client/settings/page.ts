// What the Settings page's sections share: the page's live state against its saved
// baseline, the hooks a section answers so one save bar can commit them all, and the head
// every section wears.

import type { ProviderStatusView } from "../../shared/provider";
import type { ConfirmationEmailCopy, SettingsResponse, SettingsView } from "../../shared/settings";
import { describeError } from "../api";
import { type Html, html } from "../ui/html";
import { type IconName, icon } from "../ui/icons";

/** The persisted fields the save bar tracks against their saved baseline. */
export interface SettingsBaseline {
  name: string;
  tagline: string;
  address: string;
  recipients: string[];
  confirmation: ConfirmationEmailCopy;
  /** Where notifications about sends go (SPEC §8); "" for none. */
  notifyTo: string;
}

/** The page's live, in-memory state: the baseline fields plus the logo, which saves on
 *  its own the moment it changes. */
export interface SettingsFormState extends SettingsBaseline {
  logoUrl: string;
}

/** What a section is handed: the page's read, its live state, and the way back to the
 *  page when that state changes. */
export interface SettingsPage {
  data: SettingsResponse;
  /** The provider's connection (GET /api/provider), or null without SES or when the read failed. */
  provider: ProviderStatusView | null;
  state: SettingsFormState;
  /** The state as last saved: what Discard returns to, and what a test is sent from. */
  saved(): SettingsBaseline;
  /** The From display name as the email resolves it, "" for a bare address. What a reader
   *  sees falls back to this, so it never shows a name the publisher didn't choose. */
  fromDisplay: string;
  /** The same with a visible placeholder, for what only the publisher sees. */
  fromName: string;
  /** The state changed: every section repaints what it derives from it, and the save
   *  bar rises or falls. */
  changed(): void;
  /** A save landed outside the save bar (the logo's): the page adopts the saved settings. */
  applySaved(settings: SettingsView): void;
}

/** What a section answers once mounted. `repaint` redraws what it derives from the state
 *  (a preview, a snippet) and runs on every change; `reset` puts its fields back to the
 *  state after a save adopts the server's result or a discard restores the baseline. */
export interface SectionHandle {
  repaint?(): void;
  reset?(): void;
}

export const message = describeError;

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
export const HIDDEN = html` hidden`;

/** A section's intent chip: editable, read-only, copy-out, or a preview. */
export function chip(kind: IconName, label: string): Html {
  return html`<span class="set-chip ${kind}">${icon(kind)}${label}</span>`;
}

/** A section's head: its title, its chips, and the rule that runs to the edge. */
export function secHead(title: string, chipHtml: Html, extra: Html | null = null): Html {
  return html`<div class="set-sec-head"><h2 class="set-sec-title">${title}</h2>${chipHtml}${extra}<span class="set-rule"></span></div>`;
}

/** The letter an inbox row shows for a sender with no avatar. */
export function monogram(name: string, fallback: string): string {
  return (String(name || fallback).trim()[0] || "K").toUpperCase();
}
