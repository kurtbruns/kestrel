// Edits the post body the way typing does, so the browser keeps them in its undo history.
// Writing a textarea's `.value` replaces its contents wholesale and wipes that history, so a
// toolbar button or an inserted image could not be undone with ⌘Z and took everything typed
// before it out of reach too. Going through the editing command records one undo step and
// fires `input`, which is what repaints the highlight, marks the draft dirty, and autosaves.

/**
 * Replaces `start`–`end` of the textarea with `text` as one undoable edit, then selects
 * `select` (offsets in the new text), and fires `input` either way. Where the browser can't
 * run the editing command on this textarea (no support, or the field can't take focus while
 * hidden), it falls back to `setRangeText`, which still fires `input` but isn't undoable.
 */
export function replaceRange(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  select: { start: number; end: number },
): void {
  const doc = ta.ownerDocument;
  // An image can land while the publisher types elsewhere (the subject): the edit borrows the
  // body's focus and hands it back, so their next keystroke stays where they put it.
  const prior = doc.activeElement;
  const giveBack =
    prior !== ta &&
    (prior instanceof HTMLInputElement ||
      prior instanceof HTMLTextAreaElement ||
      (prior instanceof HTMLElement && prior.isContentEditable))
      ? prior
      : null;
  ta.focus();
  ta.setSelectionRange(start, end);
  // The command acts on whatever has focus, so it runs only once the body really has it: a
  // hidden textarea (the Preview tab) refuses focus, and the command would land elsewhere.
  const focused = doc.activeElement === ta;
  const done =
    focused &&
    typeof doc.execCommand === "function" && // absent outside browsers (the spec's happy-dom)
    // execCommand is deprecated with no replacement for an undoable textarea edit; every
    // current browser still runs insertText on a focused textarea.
    (text === ""
      ? start === end || doc.execCommand("delete", false)
      : doc.execCommand("insertText", false, text));
  if (!done) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: text === "" ? "deleteContent" : "insertText",
        data: text === "" ? null : text,
      }),
    );
  }
  ta.setSelectionRange(select.start, select.end);
  giveBack?.focus();
}
