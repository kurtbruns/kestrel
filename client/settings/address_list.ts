// A list of the publisher's own addresses edited in place on the Settings page: removable
// chips and an add row, each address checked as it is added. The default test recipients
// and the notifications addresses both use it. Adding or removing one is a complete act,
// so it saves that list at once, on its own, rather than through the save bar (DESIGN §6).

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { fieldError, toast } from "../ui/widgets";
import { type AddressListKey, message, type SectionHandle, type SettingsPage } from "./page";

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
  /** Which of the page's lists this is: what it reads, and what a change saves. */
  key: AddressListKey;
  /** The list's name in the toast a saved change shows ("Added a@b.c to …"). */
  name: string;
  /** What the chips say while the list is empty. */
  empty: string;
  /** The most addresses the list takes, with what the field says when it is full. */
  max?: { count: number; full: string };
}

/** Wire the chips and the add row, each change saved at once; `reset` repaints the chips
 *  from the live state. */
export function mountAddressList(
  root: HTMLElement,
  page: SettingsPage,
  opts: AddressListOptions,
): SectionHandle {
  const chips = $(`#${opts.ids.chips}`, root);
  const input = $<HTMLInputElement>(`#${opts.ids.input}`, root);
  const addBtn = $<HTMLButtonElement>(`#${opts.ids.add}`, root);
  const current = () => page.state[opts.key];
  const render = () => {
    const list = current();
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
  // One change at a time: each saves the whole list, so a second sent while the first is
  // under way would be built on the list before it and could undo it. Add and every ×
  // stay disabled until the save lands, whichever started it.
  let saving = false;
  let clearMark: (() => void) | null = null;
  /** Save `next`, the list after one change. `removed` is the index of the address a ×
   *  took out, or null for an add: a refused removal keeps focus on that ×, since there is
   *  nothing typed to fix, and a refused add moves it to the field. */
  const save = async (next: string[], done: string, removed: number | null) => {
    clearMark?.();
    clearMark = null;
    saving = true;
    const label = addBtn.textContent;
    addBtn.disabled = true;
    if (removed === null) {
      addBtn.textContent = "Adding…";
    }
    for (const b of chips.querySelectorAll<HTMLButtonElement>("[data-rm]")) {
      b.disabled = true;
    }
    try {
      await page.saveList(opts.key, next);
      render();
      toast(done);
      return true;
    } catch (err) {
      // A refusal is the list's field's to say (DESIGN §5), and the list stays as it was.
      render();
      clearMark = fieldError(input, message(err));
      const back =
        removed === null ? input : chips.querySelector<HTMLElement>(`[data-rm="${removed}"]`);
      (back ?? input).focus();
      return false;
    } finally {
      saving = false;
      addBtn.disabled = false;
      addBtn.textContent = label;
    }
  };
  chips.addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-rm]") : null;
    if (!b || saving) {
      return;
    }
    const list = current();
    const i = Number(b.dataset.rm);
    const addr = list[i];
    void save(
      list.filter((_, j) => j !== i),
      `Removed ${addr} from ${opts.name}`,
      i,
    );
  });
  const add = async () => {
    const v = normalizeEmail(input.value);
    // While a change is saving, Add is disabled and Enter in the field waits with it.
    if (!v || saving) {
      return;
    }
    const list = current();
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
    if (await save([...list, v], `Added ${v} to ${opts.name}`, null)) {
      input.value = "";
    }
  };
  addBtn.onclick = () => void add();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void add();
    }
  });
  render();
  return { reset: render };
}
