// The logo upload's preview step: the chosen image made square and shown at the sizes it
// appears (the email sign-off, the reader pages, the sidebar) before anything is saved.

import { $ } from "../ui/dom";
import { html } from "../ui/html";
import { centerSquare, squareImage } from "../ui/square_image";
import { modal } from "../ui/widgets";

/** The side of the square PNG a logo is uploaded as: sharp at 3× the largest place it is
 *  shown (the reader pages' 64 px), and small enough for any inbox. */
export const LOGO_SIZE = 256;

/**
 * Square the chosen image and show how it will look, everywhere it is shown. Resolves the
 * PNG to upload, or null when the publisher cancels. Rejects when the file isn't an image
 * the browser can read.
 */
export async function previewLogo(file: File): Promise<Blob | null> {
  const squared = await squareImage(file, LOGO_SIZE);
  const { side } = centerSquare(squared.width, squared.height);
  const cropped = squared.width !== squared.height;
  const soft = side < LOGO_SIZE;
  // Each at its real size and corner, so the preview is the logo as readers will see it.
  const shot = (size: number, where: string, label: string) =>
    html`<figure class="logo-pv-item"><img class="logo-pv-${where}" src="${squared.url}" alt="" width="${String(size)}" height="${String(size)}"><figcaption>${label}</figcaption></figure>`;
  const m = modal(
    html`<h3 id="lgHead">Your new logo</h3>
      <p class="hint">Your logo is always shown as a square. This is how it will look.</p>
      <div class="logo-pv">
        ${shot(44, "email", "Emails")}${shot(64, "page", "Your public pages")}${shot(36, "side", "Dashboard")}
      </div>
      ${cropped ? html`<p class="hint" id="lgCropped">The center square is kept; the edges outside it are cropped.</p>` : null}
      ${
        soft
          ? html`<p class="hint" id="lgSoft">This image is ${String(side)} px across, so it may look soft on sharp screens. ${String(LOGO_SIZE)} × ${String(LOGO_SIZE)} px or larger looks best.</p>`
          : null
      }
      <div class="actions"><button type="button" id="lgCancel">Cancel</button><button type="button" class="primary" id="lgGo">Upload logo</button></div>`,
  );
  const box = $(".modal", m.el);
  box.setAttribute("aria-labelledby", "lgHead");
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Blob | null) => {
      if (!settled) {
        settled = true;
        URL.revokeObjectURL(squared.url);
        resolve(v);
      }
    };
    $("#lgCancel", box).onclick = () => {
      m.close();
      done(null);
    };
    const go = $<HTMLButtonElement>("#lgGo", box);
    go.onclick = () => {
      m.close();
      done(squared.png);
    };
    // Backdrop click / Escape close the modal without going through a button.
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        done(null);
      }
    });
    obs.observe(document.body, { childList: true });
    go.focus();
  });
}
