// The Settings page: its sections in groups by whom they serve (the publication, its
// readers, its emails, the publisher), editable first and set-at-deploy last, under one
// save bar, each with an address of its own (`#/settings/notifications`). Each section is
// its own module; this one loads the settings, holds the live state against the saved
// baseline, and commits it.

import { isDashboardRoute } from "../../shared/dashboard_link";
import { fromDisplayName, sender } from "../../shared/publication";
import {
  type ConfirmationEmailCopy,
  isSettingsSection,
  type SettingsPatchBody,
  type SettingsResponse,
  type SettingsSavedResponse,
  type SettingsView,
} from "../../shared/settings";
import { ApiError, api } from "../api";
import { renderSidebarBrand } from "../brand";
import { mount, setTitle, type ViewHandle } from "../lifecycle";
import { readProviderStatus } from "../provider_status";
import { appState } from "../state";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { savebar } from "../ui/savebar";
import { holdInView } from "../ui/scroll";
import { fieldError, renderError, toast } from "../ui/widgets";
import { confirmationSection, mountConfirmation } from "./confirmation";
import { instanceSection, mountSender, senderSection } from "./deploy";
import { mountRecipients, mountTemplate, recipientsSection, templateSection } from "./emails";
import { identitySection, mountIdentity } from "./identity";
import { mountNotifications, notificationsSection } from "./notifications";
import {
  chip,
  message,
  type SectionHandle,
  type SettingsBaseline,
  type SettingsFormState,
  type SettingsPage,
  secHead,
  sectionHeadId,
} from "./page";
import { mountReaderPages, readerPagesSection } from "./reader_pages";
import { expireRemakeWait, remakeIdentity, savedToast, withRemakeConfirm } from "./remake";
import { mountSubscribe, subscribeSection } from "./subscribe";
import { mountTimeZone, timeZoneChanged, timeZoneSection } from "./time_zone";

/** One group of sections, kept together by whom they serve: no heading of its own, since
 *  the sections' titles already say what each is, only a wider gap from the next group. */
function group(id: string, sections: Html[]): Html {
  return html`<div class="set-group" data-group="${id}">${sections}</div>`;
}

function baselineOf(state: SettingsBaseline): SettingsBaseline {
  return {
    name: state.name,
    tagline: state.tagline,
    address: state.address,
    confirmation: { ...state.confirmation },
    timeZone: state.timeZone,
  };
}

const sameCopy = (a: ConfirmationEmailCopy, b: ConfirmationEmailCopy) =>
  a.subject === b.subject &&
  a.body === b.body &&
  a.button_label === b.button_label &&
  a.reassurance === b.reassurance;

/**
 * The Settings view. `section` is the route's segment after `settings`: a section's name
 * opens the page at that section, and anything else opens it at the top.
 */
export async function renderSettings(
  root: HTMLElement,
  signal: AbortSignal,
  section?: string,
): Promise<ViewHandle | undefined> {
  setTitle(signal, "Settings");
  setHtml(
    root,
    html`<div class="settings"><div class="page-head"><h1>Settings</h1><p class="set-lede set-page-lede">Your publication’s identity, the ways readers subscribe and the pages they land on, the email each post is sent inside, and where Kestrel tells you about your sends. Facts set when Kestrel was deployed come last, read-only.</p></div><div id="settingsBody" class="muted">Loading…</div></div>`,
  );
  const body = $("#settingsBody", root);
  let data: SettingsResponse;
  try {
    data = await api<SettingsResponse>("/api/settings", { signal });
  } catch (e) {
    renderError(body, message(e), () => mount((r, s) => renderSettings(r, s, section)));
    return;
  }
  const provider = await readProviderStatus(data.deployment, signal);
  const s = data.settings;
  const p = s.publication;
  const ce = s.confirmation_email;
  // Live, in-memory state. The save bar tracks the persisted fields against the saved
  // baseline. The logo (its own endpoints) and the address lists (a write of that list
  // alone) save the moment they change, and the email template has its own page and its
  // own Save, so none of them feeds the bar.
  const state: SettingsFormState = {
    name: p.name || "",
    tagline: p.tagline || "",
    address: p.address || "",
    logoUrl: p.logo_url || "",
    recipients: [...(s.test_recipients || [])],
    // The confirmation email's words (SPEC §7); the layout, masthead, and confirm link
    // are Kestrel's.
    confirmation: {
      subject: ce.subject || "",
      body: ce.body || "",
      button_label: ce.button_label || "",
      reassurance: ce.reassurance || "",
    },
    notifyTo: [...s.notifications.to],
    timeZone: s.time_zone,
  };
  let baseline = baselineOf(state);
  const fromAddress = data.deployment.from_address;

  const isDirty = () =>
    state.name !== baseline.name ||
    state.tagline !== baseline.tagline ||
    state.address !== baseline.address ||
    !sameCopy(state.confirmation, baseline.confirmation) ||
    timeZoneChanged(state.timeZone, baseline.timeZone);

  const handles: SectionHandle[] = [];
  // The shared bottom save bar (Save + Discard), its callbacks the hoisted saveSettings /
  // discardSettings below.
  const bar = savebar.attach({ onSave: saveSettings, onDiscard: discardSettings }, signal);
  let refreshReaderPages = () => {};
  const page: SettingsPage = {
    data,
    provider,
    state,
    saved: () => baseline,
    fromOverride: fromDisplayName(fromAddress),
    sender: (name = state.name) => sender(name, fromAddress),
    changed() {
      for (const h of handles) {
        h.repaint?.();
      }
      bar.setDirty(isDirty());
    },
    // Keep the cached config and the sidebar brand, which reads the same identity, in
    // step with a save: this page's own response, with the saved half.
    applySaved(settings: SettingsView) {
      appState.appConfig = { ...data, settings };
      renderSidebarBrand();
      // The reader pages wear the saved identity, so the one shown re-reads it.
      refreshReaderPages();
    },
    // A partial write carrying the one list, so the page's other unsaved edits stay
    // unsaved and the bar keeps counting them. A list change never reaches an email, so
    // it never asks to re-make scheduled ones. The state takes the server's normalized
    // list only once it lands: a refusal leaves the list as it was.
    async saveList(key, next) {
      const json: SettingsPatchBody =
        key === "recipients" ? { test_recipients: next } : { notifications: { to: next } };
      const r = await api<SettingsSavedResponse>("/api/settings", { method: "PUT", json });
      state[key] = [
        ...(key === "recipients" ? r.settings.test_recipients : r.settings.notifications.to),
      ];
      // Only the cached config moves: the sidebar brand and the reader pages wear the
      // identity, which a list never changes, so they aren't redrawn.
      appState.appConfig = { ...data, settings: r.settings };
      page.changed();
    },
  };

  setHtml(
    body,
    html`
      ${group("publication", [identitySection(page), timeZoneSection(page)])}
      ${group("readers", [subscribeSection(page), confirmationSection(page), readerPagesSection(secHead("reader-pages", chip("preview", "Preview")))])}
      ${group("emails", [templateSection(page), recipientsSection()])}
      ${group("you", [notificationsSection(page)])}
      ${group("deploy", [senderSection(page), instanceSection(page)])}
    `,
  );
  handles.push(
    mountIdentity(body, page, signal),
    mountTimeZone(body, page, signal),
    mountSubscribe(body, page),
    mountConfirmation(body, page),
    mountTemplate(body, page, signal),
    mountRecipients(body, page),
    mountNotifications(body, page),
    mountSender(body, page),
  );
  // The template lede's and the identity note's word that saving has to wait, until it no longer does.
  expireRemakeWait(body, data.in_use, signal);
  const readerPages = mountReaderPages(body, data.deployment, signal);
  refreshReaderPages = readerPages.refresh;

  // --- save / discard. Wired into the shared save bar above; the controller runs
  // saveSettings inside busy() on its Save button, so these stay plain callbacks.
  // The field a refused save marked, cleared when the next save starts or the edits are
  // discarded, neither of which edits the field itself.
  let clearFieldMark: (() => void) | null = null;
  const unmarkField = () => {
    clearFieldMark?.();
    clearFieldMark = null;
  };
  async function saveSettings() {
    unmarkField();
    try {
      // An identity change the template renders reaches every scheduled email, so the
      // server may ask for the acknowledgement first (withRemakeConfirm); a save that
      // touches only the confirmation wording never does. The address lists save on
      // their own, so this write leaves them out and can't put back an older list.
      const payload: SettingsPatchBody = {
        publication: { name: state.name, tagline: state.tagline, address: state.address },
        confirmation_email: state.confirmation,
        // Only a zone chosen on purpose and different from the saved one: the section never
        // fills one in, so an untouched zone is never sent.
        ...(timeZoneChanged(state.timeZone, baseline.timeZone)
          ? { time_zone: state.timeZone ?? "" }
          : {}),
      };
      const r = await withRemakeConfirm(
        (ack) =>
          api<SettingsSavedResponse>("/api/settings", {
            method: "PUT",
            json: ack ? { ...payload, remake: ack } : payload,
          }),
        remakeIdentity("Save", "Saving"),
        signal,
      );
      if (!r) {
        return; // declined: the edits stay, the bar stays up
      }
      // Adopt the server's normalized result (trim, lowercase, dedupe) as the baseline.
      const ns = r.settings;
      state.name = ns.publication.name;
      state.tagline = ns.publication.tagline;
      state.address = ns.publication.address;
      state.confirmation = { ...ns.confirmation_email };
      state.timeZone = ns.time_zone;
      baseline = baselineOf(state);
      for (const h of handles) {
        h.reset?.();
        h.saved?.(r);
      }
      page.applySaved(ns);
      page.changed(); // clean now: slides the bar away
      toast(savedToast("Settings saved", r.remade));
    } catch (err) {
      // A failed save leaves the edits in place (still dirty, so the bar stays up), and the
      // bar says why, as on the Template page: a toast would sit over the bar and vanish
      // while the edits it is about are still unsaved (DESIGN §5). A refusal naming a field
      // on the page says why under that field, focuses it, and the bar points there.
      const input = err instanceof ApiError ? fieldInput(root, err.field) : null;
      if (input && err instanceof ApiError) {
        clearFieldMark = fieldError(input, message(err));
        input.focus();
        bar.showError("Not saved: fix the field marked above.");
      } else {
        bar.showError(message(err));
      }
    }
  }
  function discardSettings() {
    unmarkField();
    Object.assign(state, baselineOf(baseline));
    for (const h of handles) {
      h.reset?.();
    }
    page.changed();
  }

  page.changed();

  // The previews above a section size themselves as they load, so the jump holds the section
  // in place until the page settles rather than scrolling once. Moving between sections
  // stays on this mount, so a link within the page never costs the unsaved edits.
  let release = () => {};
  const show = (name: string | undefined) => {
    release();
    if (isSettingsSection(name)) {
      release = holdInView($(`#${sectionHeadId(name)}`, root), root, signal);
    } else {
      release = () => {};
      window.scrollTo(0, 0);
    }
  };
  if (isSettingsSection(section)) {
    show(section);
  }
  const navigate = (hash: string) => {
    const [, view, name] = hash.split("/");
    // The router's own rule for an address, so a mangled one leaves as a fresh load of it does.
    if (view !== "settings" || !isDashboardRoute(hash.slice(1))) {
      return false;
    }
    show(name);
    return true;
  };
  // A title's link moves the hash and comes back through `navigate`, except the one for the
  // address already in the bar, which fires no hashchange: that click still lands on its section.
  body.addEventListener(
    "click",
    (ev) => {
      const link = ev.target instanceof Element ? ev.target.closest(".set-sec-link") : null;
      const plain = !(ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey);
      if (plain && link?.getAttribute("href") === location.hash) {
        navigate(location.hash);
      }
    },
    { signal },
  );
  return { navigate };
}

// The input each settings field the save bar's write can name is edited in, by its wire
// name. The address lists save on their own and say a refusal on their own field.
const FIELD_INPUTS: Record<string, string> = {
  "publication.name": "#setName",
  "publication.tagline": "#setTagline",
  "publication.address": "#setAddress",
  "confirmation_email.subject": "#ceSubject",
  "confirmation_email.body": "#ceMessage",
  "confirmation_email.button_label": "#ceButton",
  "confirmation_email.reassurance": "#ceFooter",
  time_zone: "#tzSearch",
};

/** The input a refusal's `field` names, when the page shows it; null otherwise. */
function fieldInput(
  root: HTMLElement,
  field: string | null,
): HTMLInputElement | HTMLTextAreaElement | null {
  const sel = field ? FIELD_INPUTS[field] : undefined;
  const el = sel ? root.querySelector(sel) : null;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    !el.closest("[hidden]")
    ? el
    : null;
}
