// Where a dropped image will go, shown while a file is held over the post body. The image
// lands at the text caret, not under the pointer, and a textarea shows no caret during a drag
// (the window isn't the one with focus), so a marker is drawn at it. The place is read off the
// highlight layer, which lays the same text out in the same box as the textarea and carries one
// row per source line (ui/highlight.ts).

/**
 * The caret's box at `offset` of `text`, in viewport coordinates, measured in the highlight
 * layer's `code` element. Null when the layer has no row for that line or nothing is laid out.
 */
export function caretBox(code: Element, text: string, offset: number): DOMRect | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const row = code.children[text.slice(0, lineStart).split("\n").length - 1];
  if (!row) {
    return null;
  }
  let column = offset - lineStart;
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (column <= length) {
      const range = row.ownerDocument.createRange();
      range.setStart(node, column);
      range.collapse(true);
      // A caret at a wrap point has a box on each visual line; the last is where typing goes.
      const box = [...range.getClientRects()].at(-1);
      if (box?.height) {
        return box;
      }
      break;
    }
    column -= length;
  }
  // An empty row has no text to measure: the caret sits at its start, one line tall.
  const box = row.getBoundingClientRect();
  return box.height ? new DOMRect(box.left, box.top, 0, box.height) : null;
}

/**
 * Draws the marker in `frame` at the textarea's caret, or takes it away (`on` false, or a
 * caret scrolled out of the frame). The marker is the frame's own child, positioned over it.
 */
export function showDropCaret(
  frame: HTMLElement,
  code: Element,
  ta: HTMLTextAreaElement,
  on: boolean,
): void {
  frame.querySelector(".drop-caret")?.remove();
  if (!on || ta.hidden) {
    return;
  }
  const box = caretBox(code, ta.value, ta.selectionStart);
  const within = frame.getBoundingClientRect();
  if (!box || box.bottom <= within.top || box.top >= within.bottom) {
    return;
  }
  const marker = frame.ownerDocument.createElement("span");
  marker.className = "drop-caret";
  marker.setAttribute("aria-hidden", "true");
  marker.style.left = `${box.left - within.left}px`;
  marker.style.top = `${box.top - within.top}px`;
  marker.style.height = `${box.height}px`;
  frame.append(marker);
}
