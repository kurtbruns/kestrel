// The Images dialog (DESIGN, the editor): a draft's uploaded images in one list, where pressing
// a row puts that image in the post and an image the body doesn't use can be deleted. New files dropped or chosen here go to the editor's own upload, so the dialog
// never uploads or edits the text itself: it says which, and the editor does it.

import type { ImageListResponse, PostImage } from "../../shared/images";
import { ApiError, api } from "../api";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { modal } from "../ui/widgets";
import { imageUsedIn, sizeText } from "./images";

/** What the dialog hands back to the editor that opened it. */
export interface ImagesDialogHooks {
  /** The body as it stands, which decides whether each image is used. */
  body: () => string;
  /** Put a reference to this image at the caret. The dialog has closed. */
  insert: (filename: string) => void;
  /** Upload these files at the caret. The dialog has closed. */
  upload: (files: File[]) => void;
  /** An image was deleted, so a render of the post is out of date. */
  deleted: () => void;
  /** A delete or read failed for a reason the editor answers (the post gone, say). */
  failed: (e: unknown) => void;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const DROP_REGION = html`<div class="images-drop" id="imagesDrop"><span>Drop images here</span><button type="button" class="secondary" id="imagesChoose">Choose files</button><span class="images-fine">PNG, JPEG, WebP, or GIF, up to 5 MB each</span><input type="file" id="imagesInput" accept="${ACCEPT}" multiple hidden></div>`;

/** Opens the dialog over the editor of draft `postId`, for as long as `signal` lives. */
export function openImagesDialog(postId: string, signal: AbortSignal, hooks: ImagesDialogHooks) {
  const m = modal(
    html`<div class="images-dialog"><h3 id="imagesHead">Images</h3><p class="hint">Insert one where your cursor was, or add new ones. ⌘-click an image in the text to open it.</p>${DROP_REGION}<div id="imagesList"><p class="images-fine">Loading images…</p></div><p class="visually-hidden" id="imagesLive" aria-live="polite"></p><div class="actions"><button type="button" id="imagesClose">Close</button></div></div>`,
    signal,
  );
  const box = $(".modal", m.el);
  box.classList.add("modal-images");
  box.setAttribute("aria-labelledby", "imagesHead");
  const listEl = $("#imagesList", box);
  const live = $("#imagesLive", box);
  const input = $<HTMLInputElement>("#imagesInput", box);
  const drop = $("#imagesDrop", box);
  $("#imagesClose", box).onclick = m.close;
  // Choose files opens the dialog's own picker, so calling the picker off leaves the dialog open.
  $("#imagesChoose", box).onclick = () => input.click();
  const upload = (files: File[]) => {
    if (files.length) {
      m.close();
      hooks.upload(files);
    }
  };
  input.onchange = () => upload([...(input.files ?? [])]);
  // The whole dialog takes a drop, the region only shows it: a file let go a little outside the
  // dashed line still lands rather than opening in the browser.
  box.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  box.addEventListener("dragleave", (e) => {
    if (!(e.relatedTarget instanceof Node && box.contains(e.relatedTarget))) {
      drop.classList.remove("dragover");
    }
  });
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    upload([...(e.dataTransfer?.files ?? [])]);
  });

  let images: PostImage[] = [];
  // The Delete waiting on its second press, so Escape or leaving it takes the question back.
  let asking: HTMLButtonElement | null = null;
  const stopAsking = () => {
    if (asking?.isConnected) {
      asking.textContent = "Delete";
      asking.setAttribute("aria-label", `Delete ${asking.dataset.name}`);
      asking.classList.replace("danger", "danger-subtle");
    }
    asking = null;
  };
  // Ahead of the dialog's own Escape, which listens on the document: the first Escape takes
  // the question back, and only the next closes.
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && asking) {
      e.stopPropagation();
      stopAsking();
    }
  });
  box.addEventListener("focusout", (e) => {
    if (asking && e.relatedTarget !== asking) {
      stopAsking();
    }
  });

  function paint(focusAt?: number) {
    stopAsking();
    if (!images.length) {
      setHtml(listEl, html``);
      return;
    }
    const body = hooks.body();
    setHtml(
      listEl,
      html`<ul class="images-list" aria-label="This post's images">${images.map((img) => rowHtml(img, imageUsedIn(body, img.filename)))}</ul>`,
    );
    if (focusAt !== undefined) {
      const rows = listEl.querySelectorAll<HTMLButtonElement>(".images-insert");
      (
        rows[Math.min(focusAt, rows.length - 1)] ?? $<HTMLButtonElement>("#imagesChoose", box)
      ).focus();
    }
  }

  async function read(focusAt?: number) {
    try {
      images = (await api<ImageListResponse>(`/api/posts/${postId}/images`, { signal })).images;
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      m.close();
      hooks.failed(e);
      return;
    }
    if (!signal.aborted) {
      paint(focusAt);
    }
  }

  listEl.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const insert = target?.closest<HTMLButtonElement>(".images-insert");
    if (insert?.dataset.name) {
      m.close();
      hooks.insert(insert.dataset.name);
      return;
    }
    const del = target?.closest<HTMLButtonElement>(".images-delete");
    if (!del?.dataset.name) {
      return;
    }
    if (asking !== del) {
      stopAsking();
      asking = del;
      del.textContent = "Delete for good?";
      del.setAttribute("aria-label", `Delete ${del.dataset.name} for good?`);
      del.classList.replace("danger-subtle", "danger");
      return;
    }
    asking = null;
    void remove(del.dataset.name);
  });

  async function remove(name: string) {
    const at = images.findIndex((img) => img.filename === name);
    try {
      // A write, so not bound to the signal: the image goes whether or not the dialog stays.
      await api(`/api/posts/${postId}/images/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch (e) {
      // Already gone (another tab, or Claude) is what was wanted: the list is read again, and
      // if the post itself is gone, that read says so.
      if (!(e instanceof ApiError && e.status === 404)) {
        hooks.failed(e);
      }
      if (!signal.aborted) {
        await read(at);
      }
      return;
    }
    hooks.deleted();
    if (signal.aborted) {
      return;
    }
    images = images.filter((img) => img.filename !== name);
    live.textContent = `${name} deleted`;
    paint(at);
  }

  void read();
}

/** One image's row: the row itself inserts it, and Delete sits beside it. */
function rowHtml(img: PostImage, used: boolean): Html {
  // The address is the instance's own media address, but it is a URL all the same: only a web
  // one is shown (client.md, Markup).
  const web = /^https?:\/\//i.test(img.url);
  const facts = [
    img.width && img.height ? `${img.width}×${img.height}` : null,
    img.bytes === null ? null : sizeText(img.bytes),
  ].filter((f) => f !== null);
  return html`<li class="images-row">
    <button type="button" class="images-insert" data-name="${img.filename}" aria-label="Insert ${img.filename}${used ? " again" : ""}">
      <span class="images-thumb">${web ? html`<img src="${img.url}" alt="" loading="lazy">` : null}</span>
      <span class="images-text"><span class="images-name">${img.filename}</span><span class="images-meta">${facts.join(" · ")}${used ? null : html`${facts.length ? " · " : null}<span class="images-unused">Not used</span>`}</span></span>
      <span class="images-hint" aria-hidden="true">Insert</span>
    </button>
    ${used ? null : html`<button type="button" class="danger-subtle images-delete" data-name="${img.filename}" aria-label="Delete ${img.filename}">Delete</button>`}
  </li>`;
}
