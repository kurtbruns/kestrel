// Copying text out of the app, one way everywhere (DESIGN §1): a quiet Copy and its glyph,
// which says it worked where it sits, the glyph turning to a check for a moment while the
// word stays, never with a toast. A code block wears it on its label line (`codeBlock`);
// a single value (an address) wears it beside the value; either copies the plain text.

import { type Html, html, setHtml } from "./html";
import { icon } from "./icons";
import { toast } from "./widgets";

const COPIED_MS = 1500;

/** The copy control's face: its word, then its glyph, a check once a copy has landed. */
export function copyFace(copied = false): Html {
  return html`<span>Copy</span>${icon(copied ? "check" : "copyout")}`;
}

/** A Copy that puts `text` on the clipboard when clicked. `label` names what it copies,
 *  for a screen reader ("Copy curl"). */
export function copyButton(text: string, label: string): Html {
  return html`<button type="button" class="copy-btn" data-copy="${text}" aria-label="${label}">${copyFace()}</button>`;
}

/** A labelled code block with a Copy of its plain text on the label line. `code` is the
 *  block's markup (highlighted, say); `raw` is what the clipboard gets. */
export function codeBlock(label: string, code: Html, raw: string): Html {
  return html`<div class="block"><div class="block-head"><span class="block-label">${label}</span>${copyButton(raw, `Copy ${label}`)}</div><pre><code>${code}</code></pre></div>`;
}

const pending = new WeakMap<HTMLElement, { label: string; timer: number }>();

/** Copy `text` and say so on `button`: the check, and "Copied" as its accessible name,
 *  for a moment; a second copy restarts the moment. A clipboard the browser refuses is
 *  the one thing said elsewhere, since the button can't show it. */
export async function copyWith(button: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast("Couldn't copy to clipboard");
    return;
  }
  const prior = pending.get(button);
  const label = prior?.label ?? button.getAttribute("aria-label") ?? "Copy";
  window.clearTimeout(prior?.timer);
  setHtml(button, copyFace(true));
  button.setAttribute("aria-label", "Copied");
  button.classList.add("copied");
  const timer = window.setTimeout(() => {
    setHtml(button, copyFace());
    button.setAttribute("aria-label", label);
    button.classList.remove("copied");
    pending.delete(button);
  }, COPIED_MS);
  pending.set(button, { label, timer });
}

/** Every Copy under `root` (a `[data-copy]` button) copies its text when clicked: one
 *  listener on the root, so a block painted later is covered too. */
export function wireCopy(root: HTMLElement): void {
  root.addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-copy]") : null;
    if (b && root.contains(b)) {
      void copyWith(b, b.dataset.copy ?? "");
    }
  });
}
