// The shared unsaved-changes bar.

import { onAbort } from "../lifecycle";
import { html, setHtml } from "./html";
import { busy } from "./widgets";

/** A control the page always carries (public/dashboard/index.html); missing means the wrong page. */
function control<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`the admin page has no #${id}`);
  }
  return el as T;
}

export interface SavebarOptions {
  /** Runs inside busy() on the shared Save button; call setDirty(false) on success or showError() on a rejection. */
  onSave: () => unknown;
  onDiscard: () => void;
  saveLabel?: string;
  discardLabel?: string;
}

/** What a mounted page drives the bar with; inert once another page has attached. */
export interface SavebarHandle {
  setDirty(dirty: boolean): void;
  showError(text: string): void;
}

// One full-width banner fixed to the bottom of the viewport (markup in index.html),
// shared by every surface with an explicit save + a revertible baseline: Settings
// and the Template page. A page attaches once on mount, then drives it — setDirty()
// slides it up while there are unsaved changes, showError() keeps it up after a
// rejected save and says why (right beside Save). The bar detaches when the mount's
// signal aborts, so a page owns it exactly as long as it is mounted. The post editor
// keeps its own autosave + conflict model (see renderEditor) and deliberately does not
// use this — a "Save / Discard against a baseline" bar doesn't fit continuous autosave.
export const savebar = (() => {
  const el = control<HTMLElement>("savebar");
  const msgEl = el.querySelector(".savebar-msg");
  const saveBtn = control<HTMLButtonElement>("savebarSave");
  const discardBtn = control<HTMLButtonElement>("savebarDiscard");
  // Bumped on every attach/detach so a stale async handler (a save that resolves
  // after the user navigated away) can never drive a bar a new page now owns.
  let token = 0;

  const setMsg = (text: string) => {
    if (msgEl) {
      setHtml(msgEl, html`<span class="savebar-dot"></span><span>${text}</span>`);
    }
  };
  const reveal = () => {
    el.hidden = false;
    // Arm the slide-up: un-hide, then force a reflow so the off-screen base transform
    // is the established start state before .show flips it (a hidden → .show toggle in
    // one tick wouldn't transition). A synchronous reflow works even when the tab is
    // backgrounded and requestAnimationFrame is paused.
    void el.offsetHeight;
    el.classList.add("show");
  };

  function detach(): void {
    token++;
    el.classList.remove("show", "is-error");
    el.hidden = true;
    saveBtn.onclick = null;
    discardBtn.onclick = null;
    // Drop the bottom padding the page reserved for the (fixed) bar.
    document.body.classList.remove("has-savebar");
  }

  /** Attach the bar to the mounting page for the life of its signal; returns the handle the page drives. */
  function attach(
    { onSave, onDiscard, saveLabel = "Save changes", discardLabel = "Discard" }: SavebarOptions,
    signal: AbortSignal,
  ): SavebarHandle {
    const mine = ++token;
    onAbort(signal, () => {
      if (token === mine) {
        detach();
      }
    });
    saveBtn.textContent = saveLabel;
    discardBtn.textContent = discardLabel;
    el.classList.remove("show", "is-error");
    setMsg("You have unsaved changes.");
    el.hidden = true; // revealed on the first setDirty(true) / showError()
    // Reserve bottom room on the content for the whole time this page is mounted, so
    // the last section never slides under the fixed bar (no shift as it toggles).
    document.body.classList.add("has-savebar");
    saveBtn.onclick = () => busy(saveBtn, "Saving…", () => Promise.resolve(onSave()));
    discardBtn.onclick = () => onDiscard();
    const alive = () => token === mine;
    return {
      setDirty(dirty) {
        if (!alive()) {
          return;
        }
        el.classList.remove("is-error");
        if (dirty) {
          setMsg("You have unsaved changes.");
          reveal();
        } else {
          el.classList.remove("show");
        }
      },
      showError(text) {
        if (!alive()) {
          return;
        }
        el.classList.add("is-error");
        setMsg(text);
        reveal();
      },
    };
  }

  return { attach };
})();
