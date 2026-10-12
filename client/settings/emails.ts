// Settings' "Your emails" group: the email template, shown as a sample email with the way
// to the Template page where it is edited, and the default test recipients the publisher
// proofs a post against.

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { toast } from "../ui/widgets";
import { chip, type SectionHandle, type SettingsPage, secHead } from "./page";
import { inUseChip } from "./remake";
import { mountSampleEmailPreview } from "./template";

/** The template as what a publication's email looks like: a sample email in the saved
 *  template, read-only, with the way to the Template page, where editing lives (so each
 *  surface has one save). */
export function templateSection(page: SettingsPage): Html {
  return html`
    <section class="set-sec">
      ${secHead("Email template", chip("editable", "Editable"), inUseChip(page.data.inUse))}
      <p class="set-lede">The template controls the look and feel of the emails you send. Edit it on the Template page.</p>
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
  const template = page.data.settings.emailTemplate || "";
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

export function recipientsSection(): Html {
  return html`
    <section class="set-sec">
      ${secHead("Default test recipients", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-recip">
          <p class="field-hint" style="margin:0">Pre-filled into <strong>Send test email</strong> so you can proof a post against your own inboxes before scheduling. These are your addresses, and they don’t go through the subscribe/consent flow.</p>
          <div class="set-chips" id="recipChips"></div>
          <div class="set-recip-add">
            <input type="email" id="recipInput" placeholder="you@example.com" autocomplete="off">
            <button type="button" id="recipAdd">Add inbox</button>
          </div>
        </div>
      </div>
    </section>`;
}

/** Removable chips and an add row; the list commits through the save bar. */
export function mountRecipients(root: HTMLElement, page: SettingsPage): SectionHandle {
  const { state } = page;
  const chips = $("#recipChips", root);
  const input = $<HTMLInputElement>("#recipInput", root);
  const render = () => {
    if (!state.recipients.length) {
      setHtml(
        chips,
        html`<span class="set-recip-empty">No default recipients yet. Add one below.</span>`,
      );
      return;
    }
    setHtml(
      chips,
      html`${state.recipients.map(
        (addr, i) =>
          html`<span class="set-recip-chip">${addr}<button type="button" data-rm="${i}" aria-label="Remove ${addr}">${icon("x")}</button></span>`,
      )}`,
    );
  };
  chips.addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-rm]") : null;
    if (!b) {
      return;
    }
    state.recipients.splice(Number(b.dataset.rm), 1);
    render();
    page.changed();
  });
  const add = () => {
    const v = normalizeEmail(input.value);
    if (!v) {
      return;
    }
    if (!isValidEmail(v)) {
      toast("That doesn’t look like an email address.");
      return;
    }
    if (state.recipients.includes(v)) {
      toast("That inbox is already in the list.");
      input.value = "";
      return;
    }
    state.recipients.push(v);
    input.value = "";
    render();
    page.changed();
  };
  $("#recipAdd", root).onclick = add;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  render();
  return { reset: render };
}
