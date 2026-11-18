// The text side of adding an image to a draft: whether a file can go up at all, and the
// placeholder line that holds its place while it does. The placeholder goes in the moment the
// image arrives and is swapped for the real reference when the upload answers, so the image
// lands where it was dropped, in the order it was dropped, however long the upload takes. It is
// an HTML comment, as GitHub's editor uses, so one left behind (a tab closed mid-upload) shows
// nothing in the preview, the email, or the post's page. Pure, so the editor only wires it to
// the textarea and the request.

import {
  IMAGE_TOO_LARGE,
  IMAGE_TYPE_BY_EXTENSION,
  MAX_POST_IMAGE_BYTES,
  NOT_AN_IMAGE,
} from "../../shared/images";

const UPLOADABLE_TYPES = new Set(Object.values(IMAGE_TYPE_BY_EXTENSION));

/**
 * Why a file can't be uploaded, in the server's words with the file named, or null when it can
 * go. Checked before anything is sent, so a large photo is refused at once rather than after it
 * has gone up in full. The server still decides: this reads only the declared type and the size.
 */
export function uploadRefusal(file: File): string | null {
  if (!UPLOADABLE_TYPES.has(file.type)) {
    return `“${file.name}” isn’t an image Kestrel can add. ${NOT_AN_IMAGE}`;
  }
  if (file.size > MAX_POST_IMAGE_BYTES) {
    return `“${file.name}” is ${(file.size / (1024 * 1024)).toFixed(1)} MB. ${IMAGE_TOO_LARGE}`;
  }
  return null;
}

/**
 * The placeholder for an upload of `name`, unlike any in `text` and any of `uploading`, the
 * placeholders of uploads still out, so two uploads of one name each find their own. An upload
 * still out keeps its name even when its line has left the text (an undo took it out), or a
 * later paste, which a browser names image.png too, would take its line and land its image.
 * The name loses the characters that could end the comment or its quotes, or break the line,
 * since a placeholder has to stay one comment to be found again.
 */
export function placeholderFor(name: string, text: string, uploading: ReadonlySet<string>): string {
  const shown =
    name
      .replace(/[<>"\n\r]/g, "")
      .replace(/-{2,}/g, "-")
      .trim() || "image";
  let candidate = `<!-- Uploading "${shown}"… -->`;
  for (let n = 2; text.includes(candidate) || uploading.has(candidate); n++) {
    candidate = `<!-- Uploading "${shown}" (${n})… -->`;
  }
  return candidate;
}

/** The textarea's text and selection when an edit is worked out. */
export interface TextState {
  text: string;
  start: number;
  end: number;
}

/**
 * One edit of the body, in the shape `replaceRange` (posts/text_edit.ts) applies as one undo
 * step: replace `from`–`to` with `text`, then select `select`, in offsets of the new text.
 */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
  select: { start: number; end: number };
}

/** The text an edit leaves, for working out what follows it. */
export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.from) + edit.text + text.slice(edit.to);
}

/** The line breaks an inserted placeholder brought with it, which leave with it if its upload fails. */
export interface Padding {
  before: number;
  after: number;
}

/** A placeholder's insertion, and the line breaks it added around itself. */
export interface Placed {
  edit: TextEdit;
  pad: Padding;
}

/**
 * Inserts `placeholder` at the caret as a paragraph of its own: a blank line before it unless
 * it starts the text, and one after it, counting the line breaks already there, so an image
 * never joins the paragraph beside it and no extra blank line is left. The caret goes past the
 * blank line after it, so a second image dropped at once goes below the first.
 */
export function insertPlaceholder(state: TextState, placeholder: string): Placed {
  const { text, start } = state;
  let behind = 0;
  while (behind < 2 && text[start - behind - 1] === "\n") {
    behind += 1;
  }
  let ahead = 0;
  while (ahead < 2 && text[start + ahead] === "\n") {
    ahead += 1;
  }
  const before = start === behind ? 0 : 2 - behind; // nothing but line breaks before it: the start
  const after = 2 - ahead;
  const snippet = "\n".repeat(before) + placeholder + "\n".repeat(after);
  const caret = start + snippet.length + ahead;
  return {
    edit: { from: start, to: start, text: snippet, select: { start: caret, end: caret } },
    pad: { before, after },
  };
}

/**
 * Swaps `placeholder` for `replacement` wherever it now is, keeping the selection on the text it
 * was on. An empty replacement removes the placeholder and the line breaks it went in with
 * (`pad`), where they are still beside it. Null when the placeholder is gone (the publisher
 * deleted it, or a reload replaced the text): there is no place left that was the image's, so
 * nothing is put anywhere.
 */
export function replacePlaceholder(
  state: TextState,
  placeholder: string,
  replacement: string,
  pad: Padding = { before: 0, after: 0 },
): TextEdit | null {
  let from = state.text.indexOf(placeholder);
  if (from === -1) {
    return null;
  }
  let to = from + placeholder.length;
  // Removed, it takes its own line breaks, so a failed upload leaves the text as it was.
  if (!replacement) {
    for (let n = 0; n < pad.before && state.text[from - 1] === "\n"; n++) {
      from -= 1;
    }
    for (let n = 0; n < pad.after && state.text[to] === "\n"; n++) {
      to += 1;
    }
  }
  const delta = replacement.length - (to - from);
  const moved = (pos: number) =>
    pos >= to ? pos + delta : pos > from ? from + replacement.length : pos;
  return {
    from,
    to,
    text: replacement,
    select: { start: moved(state.start), end: moved(state.end) },
  };
}
