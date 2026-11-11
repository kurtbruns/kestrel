// What the Settings page's sections share: the page's live state against its saved
// baseline, the hooks a section answers so one save bar can commit them all, and the head
// every section wears.

import type { ProviderStatusView } from "../../shared/provider";
import type { Sender } from "../../shared/publication";
import {
  type ConfirmationEmailCopy,
  type SettingsResponse,
  type SettingsSection,
  type SettingsView,
  settingsRoute,
  settingsSectionTitle,
} from "../../shared/settings";
import { describeError } from "../api";
import { type Html, html } from "../ui/html";
import { type IconName, icon } from "../ui/icons";

/** The persisted fields the save bar tracks against their saved baseline. */
export interface SettingsBaseline {
  name: string;
  tagline: string;
  address: string;
  confirmation: ConfirmationEmailCopy;
  /** The publication's time zone (SPEC §9): as saved, or as chosen and not saved yet; null
   *  until one is chosen. */
  timeZone: string | null;
}

/** The page's live, in-memory state: the baseline fields plus what saves on its own the
 *  moment it changes (DESIGN §6), so it is always as saved and never feeds the save bar:
 *  the logo and the two address lists. */
export interface SettingsFormState extends SettingsBaseline {
  logoUrl: string;
  recipients: string[];
  /** Where notifications about sends go (SPEC §8); empty for none. */
  notifyTo: string[];
}

/** An address list that saves the moment an address is added or removed. */
export type AddressListKey = "recipients" | "notifyTo";

/** What a section is handed: the page's read, its live state, and the way back to the
 *  page when that state changes. */
export interface SettingsPage {
  data: SettingsResponse;
  /** The provider's connection (GET /api/provider), or null without SES or when the read failed. */
  provider: ProviderStatusView | null;
  state: SettingsFormState;
  /** The state as last saved: what Discard returns to, and what a test is sent from. */
  saved(): SettingsBaseline;
  /** The display name written into the deploy-time From address, "" for none. Set, it is
   *  the sender's name whatever the publication is called (SPEC §9). */
  fromOverride: string;
  /** The sender every email goes out as, for the publication name given, by default the
   *  name as it is being typed: the override, else that name, over the deploy-time address. */
  sender(name?: string): Sender;
  /** The state changed: every section repaints what it derives from it, and the save
   *  bar rises or falls. */
  changed(): void;
  /** A save landed outside the save bar (the logo's): the page adopts the saved settings. */
  applySaved(settings: SettingsView): void;
  /** Save one address list as `next`, and only it, leaving every other unsaved edit as it
   *  is; the page adopts the server's list once it lands. Throws the refusal, with the
   *  list as it was. */
  saveList(key: AddressListKey, next: string[]): Promise<void>;
}

/** What a section answers once mounted. `repaint` redraws what it derives from the state
 *  (a preview, a snippet) and runs on every change; `reset` puts its fields back to the
 *  state after a save adopts the server's result or a discard restores the baseline;
 *  `unsaved` says whether it holds an edit of its own the save bar doesn't track (one it
 *  saves with a button of its own), which a leave still asks about. */
export interface SectionHandle {
  repaint?(): void;
  reset?(): void;
  unsaved?(): boolean;
}

export const message = describeError;

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
export const HIDDEN = html` hidden`;

/** A section's intent chip: editable, read-only, copy-out, or a preview. */
export function chip(kind: IconName, label: string): Html {
  return html`<span class="set-chip ${kind}">${icon(kind)}${label}</span>`;
}

/** The element id of a section's head, which a link to the section scrolls to. */
export function sectionHeadId(section: SettingsSection): string {
  return `settings-${section}`;
}

/** A section's head: its title, a link to the section's own address so it can be copied, as
 *  the API reference's headings are, then its chips and the rule that runs to the edge. */
export function secHead(section: SettingsSection, chipHtml: Html, extra: Html | null = null): Html {
  return html`<div class="set-sec-head" id="${sectionHeadId(section)}"><h2 class="set-sec-title"><a class="set-sec-link" href="#${settingsRoute(section)}">${icon("link")}${settingsSectionTitle(section)}</a></h2>${chipHtml}${extra}<span class="set-rule"></span></div>`;
}

/** The letter an inbox row shows for a sender with no avatar. */
export function monogram(name: string, fallback: string): string {
  return (String(name || fallback).trim()[0] || "K").toUpperCase();
}

/** A sender as a line of text: `Birds Weekly <hello@birds.example>`, or the address alone
 *  while it has no name. */
export function senderLine(s: Sender): string {
  return s.name ? `${s.name} <${s.address}>` : s.address;
}
