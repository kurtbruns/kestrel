// Settings' "Your emails" group: the email template, shown as a sample email with the way
// to the Template page where it is edited, and the default test recipients the publisher
// proofs a post against.

import { $ } from "../ui/dom";
import { type Html, html } from "../ui/html";
import { addressListHtml, mountAddressList } from "./address_list";
import { chip, type SectionHandle, type SettingsPage, secHead } from "./page";
import { inUseChip, remakeWaitHtml } from "./remake";
import { mountSampleEmailPreview } from "./template";

/** The template as what a publication's email looks like: a sample email in the saved
 *  template, read-only, with the way to the Template page, where editing lives (so each
 *  surface has one save). */
export function templateSection(page: SettingsPage): Html {
  return html`
    <section class="set-sec">
      ${secHead("Email template", chip("editable", "Editable"), inUseChip(page.data.in_use))}
      <p class="set-lede">The template controls the look and feel of the emails you send. Edit it on the Template page.${remakeWaitHtml(page.data.in_use)}</p>
      <div class="set-preview set-tpl-sample">
        <div class="set-preview-bar">
          <span class="set-preview-lbl">Sample email</span>
          <span class="set-preview-dot">Current template</span>
        </div>
        <iframe class="set-email-frame" id="tplPreview" title="Sample email preview" scrolling="no"></iframe>
      </div>
      <div class="row" style="margin-top:12px"><button type="button" id="tplEditLink">Edit template →</button></div>
    </section>`;
}

/** The sample follows the identity fields as they are typed. */
export function mountTemplate(root: HTMLElement, page: SettingsPage): SectionHandle {
  const template = page.data.settings.email_template || "";
  const preview = mountSampleEmailPreview(
    $<HTMLIFrameElement>("#tplPreview", root),
    () => template,
    () => ({
      name: page.state.name || page.fromDisplay,
      tagline: page.state.tagline,
      logoUrl: page.state.logoUrl,
      address: page.state.address,
    }),
  );
  $("#tplEditLink", root).onclick = () => {
    location.hash = "#/template";
  };
  return { repaint: () => preview.repaint() };
}

const RECIPIENT_IDS = { chips: "recipChips", input: "recipInput", add: "recipAdd" };

export function recipientsSection(): Html {
  return html`
    <section class="set-sec">
      ${secHead("Default test recipients", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-recip">
          <p class="field-hint" style="margin:0">Pre-filled into <strong>Send test email</strong> so you can proof a post against your own inboxes before scheduling. These are your addresses, and they don’t go through the subscribe-and-confirm flow.</p>
          ${addressListHtml(RECIPIENT_IDS)}
        </div>
      </div>
    </section>`;
}

/** Removable chips and an add row; the list commits through the save bar. */
export function mountRecipients(root: HTMLElement, page: SettingsPage): SectionHandle {
  return mountAddressList(root, page, {
    ids: RECIPIENT_IDS,
    list: () => page.state.recipients,
    empty: "No default recipients yet. Add one below.",
  });
}
