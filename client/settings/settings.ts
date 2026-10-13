// The Settings page: its sections in groups by whom they serve (the publication, its
// readers, its emails, the publisher), editable first and set-at-deploy last, under one
// save bar. Each section is its own module; this one loads
// the settings, holds the live state against the saved baseline, and commits it.

import { fromDisplayName } from "../../shared/publication";
import type {
  ConfirmationEmailCopy,
  SettingsPatchBody,
  SettingsResponse,
  SettingsSavedResponse,
  SettingsView,
} from "../../shared/settings";
import { ApiError, api } from "../api";
import { renderSidebarBrand } from "../brand";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { savebar } from "../ui/savebar";
import { fieldError, renderError, toast } from "../ui/widgets";
import { confirmationSection, mountConfirmation } from "./confirmation";
import { instanceSection, senderSection } from "./deploy";
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
} from "./page";
import { mountReaderPages, readerPagesSection } from "./reader_pages";
import { remakeIdentity, savedToast, withRemakeConfirm } from "./remake";
import { mountSubscribe, subscribeSection } from "./subscribe";

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
    recipients: [...state.recipients],
    confirmation: { ...state.confirmation },
    notifyTo: state.notifyTo,
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameCopy = (a: ConfirmationEmailCopy, b: ConfirmationEmailCopy) =>
  a.subject === b.subject &&
  a.body === b.body &&
  a.buttonLabel === b.buttonLabel &&
  a.reassurance === b.reassurance;

export async function renderSettings(root: HTMLElement, signal: AbortSignal): Promise<void> {
  setHtml(
    root,
    html`<div class="settings"><div class="page-head"><h1>Settings</h1><p class="set-lede set-page-lede">Your publication’s identity, the ways readers subscribe and the pages they land on, the email each post is sent inside, and where Kestrel tells you about your sends. Facts set when Kestrel was deployed come last, read-only.</p></div><div id="settingsBody" class="muted">Loading…</div></div>`,
  );
  const body = $("#settingsBody", root);
  let data: SettingsResponse;
  try {
    data = await api<SettingsResponse>("/api/settings", { signal });
  } catch (e) {
    renderError(body, message(e), () => mount(renderSettings));
    return;
  }
  const s = data.settings;
  const p = s.publication;
  const ce = s.confirmationEmail;
  // Live, in-memory state. The save bar tracks the persisted fields against the saved
  // baseline; the logo saves the moment it changes (its own endpoints), and the email
  // template has its own page and its own Save, so neither feeds the bar.
  const state: SettingsFormState = {
    name: p.name || "",
    tagline: p.tagline || "",
    address: p.address || "",
    logoUrl: p.logoUrl || "",
    recipients: [...(s.testRecipients || [])],
    // The confirmation email's words (SPEC §7); the layout, masthead, and confirm link
    // are Kestrel's.
    confirmation: {
      subject: ce.subject || "",
      body: ce.body || "",
      buttonLabel: ce.buttonLabel || "",
      reassurance: ce.reassurance || "",
    },
    notifyTo: s.notifications.to || "",
  };
  let baseline = baselineOf(state);
  const fromDisplay = fromDisplayName(data.deployment.fromAddress);

  const isDirty = () =>
    state.name !== baseline.name ||
    state.tagline !== baseline.tagline ||
    state.address !== baseline.address ||
    !sameList(state.recipients, baseline.recipients) ||
    !sameCopy(state.confirmation, baseline.confirmation) ||
    state.notifyTo !== baseline.notifyTo;

  const handles: SectionHandle[] = [];
  // The shared bottom save bar (Save + Discard), its callbacks the hoisted saveSettings /
  // discardSettings below.
  const bar = savebar.attach({ onSave: saveSettings, onDiscard: discardSettings }, signal);
  let refreshReaderPages = () => {};
  const page: SettingsPage = {
    data,
    state,
    saved: () => baseline,
    fromDisplay,
    fromName: fromDisplay || "Your publication",
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
  };

  setHtml(
    body,
    html`
      ${group("publication", [identitySection(page)])}
      ${group("readers", [subscribeSection(page), confirmationSection(page), readerPagesSection(secHead("Reader pages", chip("preview", "Preview")))])}
      ${group("emails", [templateSection(page), recipientsSection()])}
      ${group("you", [notificationsSection(page)])}
      ${group("deploy", [senderSection(page), instanceSection(page)])}
    `,
  );
  handles.push(
    mountIdentity(body, page, signal),
    mountSubscribe(body, page),
    mountConfirmation(body, page),
    mountTemplate(body, page),
    mountRecipients(body, page),
    mountNotifications(body, page),
  );
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
      // touches only recipients or the confirmation wording never does.
      const payload: SettingsPatchBody = {
        publication: { name: state.name, tagline: state.tagline, address: state.address },
        testRecipients: state.recipients,
        confirmationEmail: state.confirmation,
        notifications: { to: state.notifyTo },
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
      state.recipients = [...ns.testRecipients];
      state.confirmation = { ...ns.confirmationEmail };
      state.notifyTo = ns.notifications.to;
      baseline = baselineOf(state);
      for (const h of handles) {
        h.reset?.();
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
}

// The input each settings field the API can name is edited in, by its wire name.
const FIELD_INPUTS: Record<string, string> = {
  "publication.name": "#setName",
  "publication.tagline": "#setTagline",
  "publication.address": "#setAddress",
  testRecipients: "#recipInput",
  "notifications.to": "#notifyTo",
  "confirmationEmail.subject": "#ceSubject",
  "confirmationEmail.body": "#ceMessage",
  "confirmationEmail.buttonLabel": "#ceButton",
  "confirmationEmail.reassurance": "#ceFooter",
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
