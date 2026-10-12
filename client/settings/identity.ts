// Settings' Publication identity section (SPEC §9): the name, tagline, and mailing address,
// which commit through the save bar, and the logo, which saves the moment it changes.

import type { InUseView, LogoResponse } from "../../shared/settings";
import { api } from "../api";
import { $ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";
import { squareImage } from "../ui/square_image";
import { busy, toast } from "../ui/widgets";
import { chip, HIDDEN, message, type SectionHandle, type SettingsPage, secHead } from "./page";
import { remakeIdentity, savedToast, withRemakeConfirm } from "./remake";

/** The note under the card: where the identity shows up (the sample email shows which
 *  fields) and, only while posts are scheduled, that a save reaches them too (SPEC §9).
 *  The confirmation dialog carries the rest, at the moment it matters, so the standing
 *  note stays one or two short lines. */
function identityNote(inUse: InUseView): string {
  if (!(inUse.identityFields || []).length) {
    return "Your email template doesn’t show any of these.";
  }
  const shown = "Shown in every email.";
  const n = inUse.sends.length;
  if (!n) {
    return shown;
  }
  const reach = `Saving a change updates ${n} scheduled email${n === 1 ? "" : "s"} too; you’ll confirm first.`;
  const wait = inUse.retry_after
    ? ` One sends at ${fmt(inUse.retry_after)}, so saving waits until it has sent.`
    : "";
  return `${shown} ${reach}${wait}`;
}

/** The side of the square PNG a logo uploads as: sharp at 3× the largest place it shows
 *  (the reader pages' 64 px), and small for any inbox. */
const LOGO_SIZE = 256;

// The logo tile's background image is set from the DOM (applyLogoUi), not written into
// the markup: a URL has no place inside a style attribute the tag would escape as text.
export function identitySection(page: SettingsPage): Html {
  const { state, fromDisplay, fromName } = page;
  // The mailing address is optional (SPEC §9): with none saved it is an "Add" row, not an
  // empty field that reads as a missing required value.
  const addressOpen = Boolean(state.address);
  return html`
    <section class="set-sec">
      ${secHead("Publication identity", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-id-grid">
          <div class="set-logo-slot">
            <div class="set-logo-tile${state.logoUrl ? " has-img" : ""}" id="logoTile" role="button" tabindex="0" aria-label="Upload logo">
              <span class="set-logo-ph" id="logoPh"${state.logoUrl ? HIDDEN : null}>${icon("upload")}Upload</span>
            </div>
            <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            <div class="set-logo-actions">
              <button type="button" id="logoReplace">${state.logoUrl ? "Replace" : "Upload"}</button>
              <button type="button" class="danger-subtle" id="logoRemove"${state.logoUrl ? null : HIDDEN}>Remove</button>
            </div>
            <div class="set-logo-notes">
              <p class="field-hint">Shown as a square. Pick an image at least ${String(LOGO_SIZE)}&nbsp;×&nbsp;${String(LOGO_SIZE)}&nbsp;px; a wider or taller one is cropped to its center square.</p>
              <p class="set-field-warn" id="logoShape" hidden>Your logo isn’t square, so emails show it stretched. Replace it to have it cropped square.</p>
              <div class="field-error" id="logoError" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span></span></div>
            </div>
          </div>
          <div class="set-id-fields">
            <div class="set-field">
              <label for="setName">Name</label>
              <input id="setName" value="${state.name}" placeholder="${fromName}" maxlength="120" autocomplete="off">
              <p class="field-hint">${
                fromDisplay
                  ? html`Blank falls back to the email “From” name (“${fromDisplay}”).`
                  : "Blank leaves the publication unnamed, since the email “From” has no name."
              }</p>
            </div>
            <div class="set-field">
              <label for="setTagline">Tagline</label>
              <input id="setTagline" value="${state.tagline}" placeholder="A one-line description" maxlength="200" autocomplete="off">
              <p class="field-hint">A short line under the name on your public pages.</p>
            </div>
            <div class="set-field set-addr-add" id="addrAdd"${addressOpen ? HIDDEN : null}>
              <button type="button" class="ghost" id="addrAddBtn" aria-describedby="addrAddHint">${icon("plus")}Add a mailing address</button>
              <p class="field-hint" id="addrAddHint">For promotional email, US law (CAN-SPAM) requires a postal address in the footer. A P.O. box works.</p>
            </div>
            <div class="set-field" id="addrField"${addressOpen ? null : HIDDEN}>
              <div class="set-field-head">
                <label for="setAddress">Mailing address</label>
                <button type="button" class="danger-subtle set-field-remove" id="addrRemove">Remove</button>
              </div>
              <input id="setAddress" value="${state.address}" placeholder="PO Box 123, City, ST 00000" maxlength="300" autocomplete="off">
              <p class="set-field-warn" id="addrWarn" hidden>Your email template currently doesn’t include this field. If you send promotional email, add it to the template.</p>
            </div>
          </div>
        </div>
        <div class="set-note">${icon("info")}<span>${identityNote(page.data.inUse)}</span></div>
      </div>
    </section>`;
}

export function mountIdentity(
  root: HTMLElement,
  page: SettingsPage,
  signal: AbortSignal,
): SectionHandle {
  const { state } = page;
  const nameEl = $<HTMLInputElement>("#setName", root);
  const taglineEl = $<HTMLInputElement>("#setTagline", root);
  const addressEl = $<HTMLInputElement>("#setAddress", root);

  // --- live fields: the state follows every keystroke, and the page repaints what shows it.
  const onInput = () => {
    state.name = nameEl.value.trim();
    state.tagline = taglineEl.value.trim();
    state.address = addressEl.value.trim();
    page.changed();
  };
  nameEl.addEventListener("input", onInput);
  taglineEl.addEventListener("input", onInput);
  addressEl.addEventListener("input", onInput);

  // --- the optional address: the Add row or the open field, and the field's warning,
  // shown while an address is set and the template leaves it out.
  let addressOpen = Boolean(state.address);
  const templatePrintsAddress = (page.data.inUse.identityFields || []).includes("address");
  const addrAdd = $("#addrAdd", root);
  const addrField = $("#addrField", root);
  const addrWarn = $("#addrWarn", root);
  const applyAddressUi = () => {
    addrAdd.hidden = addressOpen;
    addrField.hidden = !addressOpen;
    addrWarn.hidden = !(addressOpen && state.address && !templatePrintsAddress);
    // Described by the warning only while it shows: a hidden element named by
    // aria-describedby is still read out.
    if (addrWarn.hidden) {
      addressEl.removeAttribute("aria-describedby");
    } else {
      addressEl.setAttribute("aria-describedby", "addrWarn");
    }
  };
  addressEl.addEventListener("input", applyAddressUi);
  $("#addrAddBtn", root).onclick = () => {
    addressOpen = true;
    applyAddressUi();
    addressEl.focus();
  };
  $("#addrRemove", root).onclick = () => {
    addressEl.value = "";
    addressOpen = false;
    onInput();
    applyAddressUi();
    $("#addrAddBtn", root).focus();
  };

  // --- logo: immediate upload / remove (their own endpoints), updated in place.
  const logoInput = $<HTMLInputElement>("#logoInput", root);
  const logoTile = $("#logoTile", root);
  const logoPh = $("#logoPh", root);
  const logoReplace = $<HTMLButtonElement>("#logoReplace", root);
  const logoRemove = $<HTMLButtonElement>("#logoRemove", root);
  // A logo uploaded before the crop step may not be square, and emails show it stretched
  // to one. Said under the tile until it is replaced; the image is read as any <img> is.
  const logoShape = $("#logoShape", root);
  const checkLogoShape = (url: string) => {
    logoShape.hidden = true;
    if (!url) {
      return;
    }
    const img = new Image();
    img.onload = () => {
      logoShape.hidden = state.logoUrl !== url || img.naturalWidth === img.naturalHeight;
    };
    img.src = url;
  };
  const applyLogoUi = () => {
    const has = !!state.logoUrl;
    checkLogoShape(state.logoUrl);
    logoTile.classList.toggle("has-img", has);
    logoTile.style.backgroundImage = has ? `url('${state.logoUrl}')` : "";
    logoPh.hidden = has;
    logoRemove.hidden = !has;
    logoReplace.textContent = has ? "Replace" : "Upload";
  };
  logoReplace.onclick = () => logoInput.click();
  logoTile.addEventListener("click", () => logoInput.click());
  logoTile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      logoInput.click();
    }
  });
  // A refused logo change (a scheduled send about to fire) is said beneath the tile,
  // field validation's home (DESIGN §2, ④): the logo has no save bar state of its own.
  const logoError = $("#logoError", root);
  const logoErrorText = $("span:last-of-type", logoError);
  const showLogoError = (msg: string) => {
    logoErrorText.textContent = msg;
    logoError.hidden = !msg;
  };
  // A logo change lands at once: the page adopts it, and every preview that shows the
  // logo repaints rather than waiting for the next identity edit.
  const logoSaved = (r: LogoResponse, done: string) => {
    state.logoUrl = r.settings.publication.logoUrl || "";
    page.applySaved(r.settings);
    applyLogoUi();
    page.changed();
    toast(savedToast(done, r.remade));
  };
  // The logo has no save bar, so whatever kept it from saving is said under its tile.
  const logoFailed = (err: unknown) => showLogoError(message(err));
  logoInput.onchange = async () => {
    const file = logoInput.files?.[0];
    logoInput.value = "";
    if (!file) {
      return;
    }
    showLogoError("");
    try {
      // Squared before it uploads: every surface shows the logo square, and an email
      // stretches one that isn't. The tile shows the result; Replace is the way back.
      const squared = await squareImage(file, LOGO_SIZE);
      const cropped = squared.width !== squared.height;
      // The logo is part of the identity, so an upload that reaches scheduled emails
      // asks first (withRemakeConfirm); the file is held and re-sent with the ids.
      const r = await withRemakeConfirm(
        (ack) => {
          const fd = new FormData();
          fd.append("file", new File([squared.png], "logo.png", { type: "image/png" }));
          const q = ack ? `?remake=${encodeURIComponent(ack.join(","))}` : "";
          return api<LogoResponse>(`/api/settings/logo${q}`, { method: "POST", body: fd });
        },
        remakeIdentity("Upload", "Uploading"),
        signal,
      );
      if (r) {
        logoSaved(r, cropped ? "Logo updated, cropped to its center square" : "Logo updated");
      }
    } catch (err) {
      logoFailed(err);
    }
  };
  logoRemove.onclick = () =>
    busy(logoRemove, "Removing…", async () => {
      showLogoError("");
      try {
        const r = await withRemakeConfirm(
          (ack) => {
            const q = ack ? `?remake=${encodeURIComponent(ack.join(","))}` : "";
            return api<LogoResponse>(`/api/settings/logo${q}`, { method: "DELETE" });
          },
          remakeIdentity("Remove", "Removing"),
          signal,
        );
        if (r) {
          logoSaved(r, "Logo removed");
        }
      } catch (err) {
        logoFailed(err);
      }
    });

  applyLogoUi();
  applyAddressUi();
  return {
    reset() {
      nameEl.value = state.name;
      taglineEl.value = state.tagline;
      addressEl.value = state.address;
      addressOpen = Boolean(state.address);
      applyAddressUi();
    },
  };
}
