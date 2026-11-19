// What the Images dialog knows about a post's images without asking the server: whether the
// body uses one, the edit that puts one in, and how big one is in words. Pure, so the dialog
// only wires it to the textarea and the list it reads.

import { insertPlaceholder, type TextEdit, type TextState } from "./uploads";

// A character that can sit inside a stored image's name, so a name found beside one is part of
// a longer name: `map.png` inside `sitemap.png` or `old-map.png`. A dot counts before the name
// (`x.map.png`), and after it only when a name character follows (`map.png.bak`), since a
// sentence can end on a name.
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Whether `body` uses the image named `filename`: the name appears as a whole name, as written,
 * with `&` written `&amp;` (raw HTML), with Markdown's backslash escapes (`my\_photo.png`), or
 * percent-encoded (an older name with a space in it).
 * That finds every use the render resolves: a Markdown image, a link, the image's full address,
 * and raw HTML. It also counts a mention in prose or a comment, which errs toward used, the
 * direction that only ever keeps an image (DESIGN, the editor).
 */
export function imageUsedIn(body: string, filename: string): boolean {
  if (!filename) {
    return false;
  }
  const unescaped = body.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
  // Markdown drops a backslash before ASCII punctuation in an address, so `my\_photo.png`
  // names `my_photo.png`, as exports from Notion and the like write it.
  const unslashed = unescaped.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  for (const text of new Set([body, unescaped, unslashed, decodePercent(unescaped)])) {
    for (let at = text.indexOf(filename); at !== -1; at = text.indexOf(filename, at + 1)) {
      if (isWholeName(text, at, filename.length)) {
        return true;
      }
    }
  }
  return false;
}

function isWholeName(text: string, at: number, length: number): boolean {
  const before = text[at - 1];
  if (before !== undefined && (before === "." || NAME_CHAR.test(before))) {
    return false;
  }
  const after = text[at + length];
  if (after === undefined) {
    return true;
  }
  if (NAME_CHAR.test(after)) {
    return false;
  }
  const next = text[at + length + 1];
  return !(after === "." && next !== undefined && NAME_CHAR.test(next));
}

/** Decodes each run of percent-escapes on its own, leaving one that isn't UTF-8 as written. */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Puts a reference to the uploaded image `filename` at the caret as a paragraph of its own, by
 * the rule an upload's placeholder follows, and selects its alt text, so the next keystrokes
 * replace the file name with a description of the picture.
 */
export function insertImage(state: TextState, filename: string): TextEdit {
  const { edit, pad } = insertPlaceholder(state, `![${filename}](${filename})`);
  const alt = edit.from + pad.before + 2; // past the line breaks and the `![`
  return { ...edit, select: { start: alt, end: alt + filename.length } };
}

/** An image's stored size as a reader would say it: `820 bytes`, `412 KB`, `1.9 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
