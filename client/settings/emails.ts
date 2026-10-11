// Settings' "Your emails" group: the email template, as one line pointing at the Template
// page where it is edited and proofed, and the default test recipients the publisher
// proofs a post against.

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { toast } from "../ui/widgets";
import { chip, type SectionHandle, type SettingsPage, secHead } from "./page";
import { inUseChip } from "./remake";

/** The template as one card: what it does, whether scheduled posts use it, and the way to
 *  the Template page. The sample email lives there, beside the editor, so Settings doesn't
 *  hold a second full-height copy of it. */
export function templateSection(page: SettingsPage): Html {
  return html`
    <section class="set-sec">
      ${secHead("Email template", chip("editable", "Editable"), inUseChip(page.data.inUse))}
      <div class="set-card set-tpl-card">
        <p class="set-tpl-card-text">Every post you send goes out inside your template: its layout, its styles, and the footer around your words. Edit it and send yourself a sample on the Template page.</p>
        <button type="button" class="primary" id="tplEditLink">Edit template →</button>
      </div>
    </section>`;
}

export function mountTemplate(root: HTMLElement): SectionHandle {
  $("#tplEditLink", root).onclick = () => {
    location.hash = "#/template";
  };
  return {};
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
        html`<span class="set-recip-empty">No default recipients yet — add one below.</span>`,
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
