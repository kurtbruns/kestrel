// Settings' Confirmation email section (SPEC §7): the double opt-in email, preview-first
// with a Preview | Edit toggle. Words only: Kestrel owns the layout and inserts the confirm
// link, so the fields can never break double opt-in. The rendered card is byte-honest to
// the transactional layout in src/emails/system.ts, in both themes (the card's dark palette
// lives in styles.css, tracking the dashboard theme).

import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { chip, monogram, type SectionHandle, type SettingsPage, secHead } from "./page";

export function confirmationSection(page: SettingsPage): Html {
  const { state, fromName } = page;
  return html`
    <section class="set-sec">
      ${secHead("Confirmation email", chip("editable", "Editable"))}
      <p class="set-lede">The email that asks a new subscriber to confirm. Edit the wording as you see fit. Kestrel adds the confirmation link.</p>
      <div class="set-preview">
        <div class="set-preview-bar set-ce-bar">
          <div class="set-ce-modetog" role="group" aria-label="Confirmation email view">
            <button type="button" class="set-ce-modebtn" id="ceTabPreview" aria-pressed="true">${icon("preview")}Preview</button>
            <button type="button" class="set-ce-modebtn" id="ceTabEdit" aria-pressed="false">${icon("editable")}Edit</button>
          </div>
        </div>
        <div id="cePreviewBody">
          <div class="set-inbox">
            <div class="set-inbox-avatar" id="cePvAvatar">${monogram(state.name, fromName)}</div>
            <div class="set-inbox-body">
              <div class="set-inbox-top"><span class="set-inbox-from" id="cePvFrom">${state.name || fromName}</span><span class="set-inbox-time">now</span></div>
              <div class="set-inbox-subj" id="cePvSubject"></div>
            </div>
          </div>
          <div class="set-ce-stage">
            <div class="set-ce-card">
              <div class="set-ce-mast" id="cePvMast" hidden>
                <div class="set-ce-mast-logo" id="cePvMastLogo"></div>
                <div>
                  <div class="set-ce-mast-name" id="cePvMastName"></div>
                  <div class="set-ce-mast-tag" id="cePvMastTag"></div>
                </div>
              </div>
              <p class="set-ce-msg" id="cePvBody"></p>
              <p class="set-ce-btnrow"><a class="set-ce-btn" id="cePvButton" href="#" onclick="return false"></a></p>
              <p class="set-ce-foot" id="cePvFoot"></p>
            </div>
          </div>
        </div>
        <div id="ceEditBody" hidden>
          <div class="set-ce-edit">
            <div class="set-field">
              <label for="ceSubject">Subject line</label>
              <input id="ceSubject" value="${state.confirmation.subject}" maxlength="200" autocomplete="off">
            </div>
            <div class="set-field">
              <label for="ceMessage">Message</label>
              <textarea id="ceMessage" rows="3" maxlength="1000">${state.confirmation.body}</textarea>
              <p class="field-hint">The line above the confirm button.</p>
            </div>
            <div class="set-field">
              <label for="ceButton">Button label</label>
              <input id="ceButton" value="${state.confirmation.button_label}" maxlength="80" autocomplete="off">
            </div>
            <div class="set-field">
              <label for="ceFooter">Reassurance line</label>
              <input id="ceFooter" value="${state.confirmation.reassurance}" maxlength="400" autocomplete="off">
              <p class="field-hint">The quiet footer for anyone who didn’t sign up. Leave blank to omit it.</p>
            </div>
          </div>
          <div class="set-ce-editfoot">
            <button type="button" class="ghost" id="ceReset">Reset to Kestrel default</button>
            <span class="grow"></span>
            <button type="button" class="ghost" id="ceToPreview">See preview →</button>
          </div>
        </div>
      </div>
    </section>`;
}

/** The fields carry only words; the preview resolves a blank required field to the
 *  built-in default (from the API) exactly as the send does, so it's never wordless. */
export function mountConfirmation(root: HTMLElement, page: SettingsPage): SectionHandle {
  const { state } = page;
  const ceDefault = page.data.settings.confirmation_email_default;
  const fields = {
    subject: $<HTMLInputElement>("#ceSubject", root),
    message: $<HTMLTextAreaElement>("#ceMessage", root),
    button: $<HTMLInputElement>("#ceButton", root),
    footer: $<HTMLInputElement>("#ceFooter", root),
  };
  const pv = {
    avatar: $("#cePvAvatar", root),
    from: $("#cePvFrom", root),
    subject: $("#cePvSubject", root),
    body: $("#cePvBody", root),
    button: $("#cePvButton", root),
    foot: $("#cePvFoot", root),
    mast: $("#cePvMast", root),
    mastLogo: $("#cePvMastLogo", root),
    mastName: $("#cePvMastName", root),
    mastTag: $("#cePvMastTag", root),
  };
  const repaint = () => {
    const c = state.confirmation;
    pv.avatar.textContent = monogram(state.name, page.fromName);
    pv.from.textContent = state.name || page.fromName;
    pv.subject.textContent = c.subject.trim() || ceDefault.subject || "";
    pv.body.textContent = c.body.trim() || ceDefault.body || "";
    pv.button.textContent = c.button_label.trim() || ceDefault.button_label || "Confirm";
    pv.foot.textContent = c.reassurance;
    pv.foot.hidden = !c.reassurance.trim();
    // The publication masthead (logo + name + tagline) up top. Mirrors masthead() in
    // src/emails/system.ts exactly: it uses the identity as the email resolves it (name
    // = publication name or the From display name, "" if neither), omits the logo cell
    // when there's no logo (rather than showing a monogram the email won't have), and
    // degrades to nothing when there's neither a name nor a logo.
    const mastName = state.name || page.fromDisplay;
    const hasLogo = Boolean(state.logoUrl);
    const showMast = hasLogo || Boolean(mastName);
    pv.mast.hidden = !showMast;
    if (showMast) {
      pv.mastLogo.hidden = !hasLogo;
      if (hasLogo) {
        setHtml(pv.mastLogo, html`<img src="${state.logoUrl}" alt="">`);
      }
      pv.mastName.textContent = mastName;
      pv.mastName.hidden = !mastName;
      pv.mastTag.textContent = state.tagline;
      pv.mastTag.hidden = !state.tagline;
    }
  };
  const onInput = () => {
    state.confirmation.subject = fields.subject.value;
    state.confirmation.body = fields.message.value;
    state.confirmation.button_label = fields.button.value;
    state.confirmation.reassurance = fields.footer.value;
    page.changed();
  };
  for (const el of Object.values(fields)) {
    el.addEventListener("input", onInput);
  }

  const editBody = $("#ceEditBody", root);
  const previewBody = $("#cePreviewBody", root);
  const tabEdit = $<HTMLButtonElement>("#ceTabEdit", root);
  const tabPreview = $<HTMLButtonElement>("#ceTabPreview", root);
  const setMode = (edit: boolean) => {
    editBody.hidden = !edit;
    previewBody.hidden = edit;
    tabEdit.setAttribute("aria-pressed", String(edit));
    tabPreview.setAttribute("aria-pressed", String(!edit));
    if (edit) {
      fields.subject.focus();
    }
  };
  tabPreview.onclick = () => setMode(false);
  tabEdit.onclick = () => setMode(true);
  $("#ceToPreview", root).onclick = () => setMode(false);
  $("#ceReset", root).onclick = () => {
    fields.subject.value = ceDefault.subject || "";
    fields.message.value = ceDefault.body || "";
    fields.button.value = ceDefault.button_label || "";
    fields.footer.value = ceDefault.reassurance || "";
    onInput();
  };

  repaint();
  return {
    repaint,
    reset() {
      fields.subject.value = state.confirmation.subject;
      fields.message.value = state.confirmation.body;
      fields.button.value = state.confirmation.button_label;
      fields.footer.value = state.confirmation.reassurance;
      repaint();
    },
  };
}
