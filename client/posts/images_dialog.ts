// The Images dialog (DESIGN, the editor): a draft's uploaded images in one list. A row's picture
// and name open its image full size, Insert puts it in the post, and the trash can deletes it: at once
// when the post doesn't use it, and only once asked when it does. New files dropped or chosen
// here go to the editor's own upload, so the dialog never uploads or edits the text itself: it
// says which, and the editor does it.

import type { ImageListResponse, PostImage } from "../../shared/images";
import type { PostResponse } from "../../shared/posts";
import { ApiError, api } from "../api";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { modal } from "../ui/widgets";
import { imageUsedIn, sizeText } from "./images";

/** What the dialog hands back to the editor that opened it. */
export interface ImagesDialogHooks {
  /** The body as it stands on screen. An image is used when it or the saved post uses it. */
  body: () => string;
  /**
   * Hands the editor a function to call when the post's text or images may have changed while
   * the dialog is open (another writer's version taken in, the out-of-date banner raised, or an
   * upload landed), so the dialog reads the images and the saved post again and says what is
   * used now.
   */
  watch: (changed: () => void) => void;
  /** Put a reference to this image at the caret. The dialog has closed. */
  insert: (filename: string) => void;
  /** Upload these files at the caret. The dialog has closed. */
  upload: (files: File[]) => void;
  /** An image was deleted, so a render of the post is out of date. */
  deleted: () => void;
  /** A delete or read failed for a reason the editor answers (the post gone, say). */
  failed: (e: unknown) => void;
}

// A bare attribute is markup, not text: spelled once so it can be interpolated.
const USED = html` data-used="1"`;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const DROP_REGION = html`<div class="images-drop" id="imagesDrop"><span>Drop images here</span><button type="button" class="secondary" id="imagesChoose">Choose files</button><span class="images-fine">PNG, JPEG, WebP, or GIF, up to 5 MB each</span><input type="file" id="imagesInput" accept="${ACCEPT}" multiple hidden></div>`;

/**
 * Opens the dialog over the editor of draft `postId`, for as long as `signal` lives. The list is
 * read first, so the dialog opens at the size it keeps rather than growing when the list lands.
 */
export async function openImagesDialog(
  postId: string,
  signal: AbortSignal,
  hooks: ImagesDialogHooks,
): Promise<void> {
  let images: PostImage[];
  // The saved post's text, beside the text on screen: under the out-of-date banner, or with
  // edits not yet saved, the two differ, and an image either uses must not read as unused,
  // since its trash then deletes at once.
  let saved: string;
  const readSaved = async () =>
    (await api<PostResponse>(`/api/posts/${postId}`, { signal })).markdown;
  try {
    [images, saved] = await Promise.all([
      api<ImageListResponse>(`/api/posts/${postId}/images`, { signal }).then((r) => r.images),
      readSaved(),
    ]);
  } catch (e) {
    if (!signal.aborted) {
      hooks.failed(e);
    }
    return;
  }
  if (signal.aborted) {
    return;
  }
  const m = modal(
    html`<div class="images-dialog"><h3 id="imagesHead">Images</h3><p class="hint">Insert one where your cursor was, or add new ones.</p>${DROP_REGION}<div id="imagesList"></div><p class="visually-hidden" id="imagesLive" aria-live="polite"></p><div class="actions"><button type="button" id="imagesClose">Close</button></div></div>`,
    signal,
  );
  const box = $(".modal", m.el);
  // A file let go on the backdrop, just outside the box, would otherwise open in the tab and
  // leave the editor.
  for (const type of ["dragover", "drop"]) {
    m.el.addEventListener(type, (e) => e.preventDefault());
  }
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

  // The delete of a used image waiting on its second press, so Escape or leaving it takes the
  // question back.
  let asking: HTMLButtonElement | null = null;
  // Ahead of the dialog's own Escape, which listens on the document: while a question is open
  // the first Escape takes it back, and only the next closes. On the document in the capture
  // phase, since Safari doesn't focus a clicked button, so focus may sit outside the box.
  const escapeTakesBack = (e: KeyboardEvent) => {
    if (e.key === "Escape" && asking) {
      e.stopImmediatePropagation();
      stopAsking();
    }
  };
  const stopAsking = () => {
    if (asking?.isConnected) {
      setHtml(asking, icon("trash"));
      asking.setAttribute("aria-label", `Delete ${asking.dataset.name}`);
      asking.closest(".images-row")?.classList.remove("asking");
    }
    asking = null;
    document.removeEventListener("keydown", escapeTakesBack, true);
  };
  box.addEventListener("focusout", (e) => {
    if (asking && e.relatedTarget !== asking) {
      stopAsking();
    }
  });

  const usedNow = () => {
    const body = hooks.body();
    return images.map((img) => imageUsedIn(body, img.filename) || imageUsedIn(saved, img.filename));
  };
  let painted = "";
  function paint(focusAt?: number) {
    stopAsking();
    const used = usedNow();
    painted = JSON.stringify([images.map((img) => img.filename), used]);
    setHtml(
      listEl,
      images.length
        ? html`<ul class="images-list" aria-label="This post's images">${images.map((img, i) => rowHtml(img, used[i] ?? true))}</ul>`
        : html``,
    );
    if (focusAt !== undefined) {
      const rows = listEl.querySelectorAll<HTMLButtonElement>(".images-insert");
      (
        rows[Math.min(focusAt, rows.length - 1)] ?? $<HTMLButtonElement>("#imagesChoose", box)
      ).focus();
    }
  }

  // The text or the images changed while the dialog was open: read both again, and repaint only
  // if the list or what is used changed, keeping focus on the control it was on.
  hooks.watch(async () => {
    if (!m.el.isConnected || signal.aborted) {
      return;
    }
    try {
      [images, saved] = await Promise.all([
        api<ImageListResponse>(`/api/posts/${postId}/images`, { signal }).then((r) => r.images),
        readSaved(),
      ]);
    } catch {
      return; // the editor answers a failed read of its own post
    }
    if (
      !m.el.isConnected ||
      JSON.stringify([images.map((i) => i.filename), usedNow()]) === painted
    ) {
      return;
    }
    const focused = document.activeElement;
    const name =
      focused instanceof HTMLElement && listEl.contains(focused) ? focused.dataset.name : undefined;
    const kind =
      focused instanceof HTMLElement
        ? focused.className.split(" ").find((c) => c.startsWith("images-"))
        : undefined;
    paint();
    if (name && kind) {
      listEl.querySelector<HTMLElement>(`.${kind}[data-name="${CSS.escape(name)}"]`)?.focus();
    }
  });

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
    // The row's own link opens the image; nothing more to do.
    if (!target || target.closest("a")) {
      return;
    }
    const insert = target.closest<HTMLButtonElement>(".images-insert");
    if (insert?.dataset.name) {
      m.close();
      hooks.insert(insert.dataset.name);
      return;
    }
    const del = target.closest<HTMLButtonElement>(".images-delete");
    if (del?.dataset.name) {
      // An image the body doesn't use goes at once: nothing in the post changes. One it uses
      // asks first, since its reference stays in the text and the preview then warns of a
      // missing image (SPEC §4).
      if (del.dataset.used && asking !== del) {
        stopAsking();
        asking = del;
        document.addEventListener("keydown", escapeTakesBack, true);
        setHtml(del, html`${icon("trash")}<span>In the post. Delete anyway?</span>`);
        del.setAttribute("aria-label", `${del.dataset.name} is in the post. Delete anyway?`);
        del.closest(".images-row")?.classList.add("asking");
        return;
      }
      asking = null;
      void remove(del.dataset.name);
    }
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

  paint();
}

/** One image's row: its picture and name open it full size, then Insert, then the trash can. */
function rowHtml(img: PostImage, used: boolean): Html {
  // The address is the instance's own media address, but it is a URL all the same: only a web
  // one is shown or linked (client.md, Markup).
  const web = /^https?:\/\//i.test(img.url);
  // Only the exception is named, as Email only is: an image the post uses is the normal case.
  const facts = [
    used ? null : "Not used",
    img.width && img.height ? `${img.width}×${img.height}` : null,
    img.bytes === null ? null : sizeText(img.bytes),
  ].filter((f) => f !== null);
  const look = html`<span class="images-thumb">${web ? html`<img src="${img.url}" alt="" loading="lazy"><span class="images-zoom">${icon("outward")}</span>` : null}</span>
      <span class="images-text"><span class="images-name">${img.filename}</span><span class="images-meta">${facts.join(" · ")}</span></span>`;
  return html`<li class="images-row${used ? "" : " unused"}">
    ${web ? html`<a class="images-open" href="${img.url}" target="_blank" rel="noopener" aria-label="Open ${img.filename} full size (new tab)">${look}</a>` : html`<span class="images-open">${look}</span>`}
    <button type="button" class="ghost images-insert" data-name="${img.filename}" aria-label="Insert ${img.filename}${used ? " again" : ""}">Insert</button>
    <button type="button" class="images-delete" data-name="${img.filename}"${used ? USED : null} aria-label="Delete ${img.filename}">${icon("trash")}</button>
  </li>`;
}
