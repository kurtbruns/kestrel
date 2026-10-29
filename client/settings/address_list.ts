// A list of the publisher's own addresses edited in place on the Settings page: removable
// chips and an add row, each address checked as it is added. The default test recipients
// and the notifications addresses both use it; the list commits through the save bar.

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { fieldError } from "../ui/widgets";
import type { SectionHandle, SettingsPage } from "./page";

/** The element ids one list is built with, so two lists on the page never collide. */
export interface AddressListIds {
  chips: string;
  input: string;
  add: string;
}

/** The chips and the add row. The input carries `ids.input`, which a refusal naming the
 *  list's field marks. */
export function addressListHtml(ids: AddressListIds): Html {
  return html`
    <div class="set-chips" id="${ids.chips}"></div>
    <div class="set-recip-add">
      <input type="email" id="${ids.input}" placeholder="you@example.com" autocomplete="off">
      <button type="button" id="${ids.add}">Add inbox</button>
    </div>`;
}

export interface AddressListOptions {
  ids: AddressListIds;
  /** The list in the page's live state, read each time: discard replaces the array. */
  list: () => string[];
  /** What the chips say while the list is empty. */
  empty: string;
  /** The most addresses the list takes, with what the field says when it is full. */
  max?: { count: number; full: string };
}

/** Wire the chips and the add row; `reset` repaints the chips from the live state. */
export function mountAddressList(
  root: HTMLElement,
  page: SettingsPage,
  opts: AddressListOptions,
): SectionHandle {
  const chips = $(`#${opts.ids.chips}`, root);
  const input = $<HTMLInputElement>(`#${opts.ids.input}`, root);
  const render = () => {
    const list = opts.list();
    if (!list.length) {
      setHtml(chips, html`<span class="set-recip-empty">${opts.empty}</span>`);
      return;
    }
    setHtml(
      chips,
      html`${list.map(
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
    opts.list().splice(Number(b.dataset.rm), 1);
    render();
    page.changed();
  });
  const add = () => {
    const v = normalizeEmail(input.value);
    if (!v) {
      return;
    }
    const list = opts.list();
    // A refused address says why on the field, and keeps what was typed so it can be fixed
    // in place; the reason goes as soon as the field is edited (DESIGN §5).
    const reason = !isValidEmail(v)
      ? "That doesn’t look like an email address."
      : list.includes(v)
        ? "That inbox is already in the list."
        : opts.max && list.length >= opts.max.count
          ? opts.max.full
          : "";
    if (reason) {
      fieldError(input, reason);
      input.focus();
      return;
    }
    list.push(v);
    input.value = "";
    render();
    page.changed();
  };
  $(`#${opts.ids.add}`, root).onclick = add;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  render();
  return { reset: render };
}
