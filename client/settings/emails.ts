// Settings' emails: the Email preview, a sample email as readers open it, with the way to the
// Template page where the template is edited, and the default test recipients the publisher
// proofs a post against.

import { settingsRoute } from "../../shared/settings";
import { $ } from "../ui/dom";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";
import { addressListHtml, mountAddressList } from "./address_list";
import { chip, type SectionHandle, type SettingsPage, secHead, senderLine } from "./page";
import { inUseChip, remakeWaitHtml } from "./remake";
import { mountSampleEmailPreview } from "./template";

/** The Email preview (SPEC §9): a sample email in the saved template as readers open it,
 *  from the sender they see, read-only, with the way to the Template page, where editing
 *  lives (so each surface has one save). The From line is the sender alone: the address is
 *  deploy config, explained in Email provider, which its mark links to. */
export function templateSection(page: SettingsPage): Html {
  return html`
    <section class="set-sec">
      ${secHead("email-template", chip("preview", "Preview"), inUseChip(page.data.in_use))}
      <p class="set-lede">An email as your readers open it, following Publication identity as you type. Its look is the template’s, edited on the Template page.${remakeWaitHtml(page.data.in_use)}</p>
      <div class="set-preview set-tpl-sample">
        <div class="set-preview-bar">
          <span class="set-preview-lbl">Sample email</span>
          <span class="set-preview-dot">Current template</span>
        </div>
        <div class="set-env">
          <span class="set-env-k">From</span>
          <span class="set-env-v"><span class="mono" id="senderFrom">${senderLine(page.sender())}</span> <a class="set-env-deploy" href="#${settingsRoute("email-sender")}">${icon("readonly")}Set at deploy<span class="visually-hidden">, in Email provider</span></a></span>
        </div>
        <iframe class="set-email-frame" id="tplPreview" title="Sample email preview" scrolling="no"></iframe>
      </div>
      <div class="row" style="margin-top:12px"><button type="button" id="tplEditLink">Edit template →</button></div>
    </section>`;
}

/** The sample and its sender follow the identity fields as they are typed: the publication's
 *  name is the sender's unless one was written into the From address at deploy (SPEC §9). */
export function mountTemplate(
  root: HTMLElement,
  page: SettingsPage,
  signal: AbortSignal,
): SectionHandle {
  const template = page.data.settings.email_template || "";
  const preview = mountSampleEmailPreview(
    $<HTMLIFrameElement>("#tplPreview", root),
    () => template,
    () => ({
      name: page.state.name,
      tagline: page.state.tagline,
      logoUrl: page.state.logoUrl,
      address: page.state.address,
    }),
    signal,
  );
  $("#tplEditLink", root).onclick = () => {
    location.hash = "#/template";
  };
  const from = $("#senderFrom", root);
  return {
    repaint() {
      preview.repaint();
      from.textContent = senderLine(page.sender());
    },
  };
}

const RECIPIENT_IDS = { chips: "recipChips", input: "recipInput", add: "recipAdd" };

export function recipientsSection(): Html {
  return html`
    <section class="set-sec">
      ${secHead("default-test-recipients", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-recip">
          <p class="field-hint" style="margin:0">Pre-filled into <strong>Send test email</strong> so you can proof a post against your own inboxes before scheduling. These are your addresses, and they don’t go through the subscribe-and-confirm flow.</p>
          ${addressListHtml(RECIPIENT_IDS)}
        </div>
      </div>
    </section>`;
}

/** Removable chips and an add row, each change saved at once. */
export function mountRecipients(root: HTMLElement, page: SettingsPage): SectionHandle {
  return mountAddressList(root, page, {
    ids: RECIPIENT_IDS,
    key: "recipients",
    name: "default test recipients",
    empty: "No default recipients yet. Add one below.",
  });
}
