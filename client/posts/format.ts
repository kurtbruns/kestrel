// What each formatting toolbar button does to the post body's text: given the text and the
// selection, the one span to replace and what to select after. A button toggles: on text that
// already carries its markup it takes the markup off, so a second click undoes the first
// instead of stacking marks. Link and Indent are the exceptions: taking a link apart would
// throw away its address, and stacking an indent is how a list nests. Pure, so the view only
// applies the edit (posts/text_edit.ts), as one step the browser can undo.

/** The post body as the toolbar reads it: its text and the selection in it. */
export interface TextSelection {
  text: string;
  start: number;
  end: number;
}

/** Replace `start`–`end` with `insert`, then select `select` (offsets in the new text). */
export interface FormatEdit {
  start: number;
  end: number;
  insert: string;
  select: { start: number; end: number };
}

/** The edit a toolbar button (or its shortcut) makes, or null for a kind the toolbar lacks. */
export function formatEdit(kind: string, at: TextSelection): FormatEdit | null {
  switch (kind) {
    case "bold":
      return toggleEmphasis(at, 2, "bold text");
    case "italic":
      return toggleEmphasis(at, 1, "italic text");
    case "code":
      return toggleCode(at);
    case "link":
      return wrap(at, "[", "](https://)", "link text");
    case "heading":
      return toggleHeading(at);
    case "quote":
      return toggleQuote(at);
    case "ul":
    case "ol":
      return toggleList(at, kind);
    case "indent":
      return eachLine(at, (lines) => lines.map((l) => `  ${l}`));
    default:
      return null;
  }
}

// --- marks around the selection ---

function wrap(at: TextSelection, before: string, after: string, placeholder: string): FormatEdit {
  const inner = at.text.slice(at.start, at.end) || placeholder;
  const start = at.start + before.length;
  return {
    start: at.start,
    end: at.end,
    insert: before + inner + after,
    select: { start, end: start + inner.length },
  };
}

/** Takes `size` characters off each side of the selection (`outside`) or off each end of the
 *  selected text (inside), leaving what they enclosed selected. */
function unwrap(at: TextSelection, size: number, outside: boolean): FormatEdit {
  const start = outside ? at.start - size : at.start;
  const end = outside ? at.end + size : at.end;
  const inner = outside
    ? at.text.slice(at.start, at.end)
    : at.text.slice(at.start + size, at.end - size);
  return { start, end, insert: inner, select: { start, end: start + inner.length } };
}

function runBefore(text: string, i: number, ch: string): number {
  let n = 0;
  while (i - n > 0 && text[i - n - 1] === ch) {
    n += 1;
  }
  return n;
}
function runAfter(text: string, i: number, ch: string): number {
  let n = 0;
  while (i + n < text.length && text[i + n] === ch) {
    n += 1;
  }
  return n;
}

/** Whether a run of asterisks carries bold (`**`, `***`) or italic (`*`, `***`). Bold and italic
 *  share the character, so italic counts only a run bold doesn't use up, and a click of Italic
 *  inside `**bold**` adds italic rather than taking a star from the bold. */
function carries(run: number, size: 1 | 2): boolean {
  return size === 2 ? run >= 2 : run % 2 === 1;
}

/** The marks around the selection or at its ends, if both sides carry them. */
function marked(
  at: TextSelection,
  ch: string,
  has: (run: number) => boolean,
): "outside" | "inside" | null {
  if (has(runBefore(at.text, at.start, ch)) && has(runAfter(at.text, at.end, ch))) {
    return "outside";
  }
  const sel = at.text.slice(at.start, at.end);
  const lead = runAfter(sel, 0, ch);
  const trail = runBefore(sel, sel.length, ch);
  // Something has to sit between the marks: a selection of nothing but asterisks isn't wrapped.
  if (lead + trail < sel.length && has(lead) && has(trail)) {
    return "inside";
  }
  return null;
}

function toggleEmphasis(at: TextSelection, size: 1 | 2, placeholder: string): FormatEdit {
  const mark = "*".repeat(size);
  const where = marked(at, "*", (run) => carries(run, size));
  return where ? unwrap(at, size, where === "outside") : wrap(at, mark, mark, placeholder);
}

const FENCE_OPEN = "```\n";
const FENCE_CLOSE = "\n```";

/** Inline code for a selection within a line, a fenced block for none or several lines; either
 *  comes off again on a second click. */
function toggleCode(at: TextSelection): FormatEdit {
  const { text, start, end } = at;
  const sel = text.slice(start, end);
  if (
    text.slice(start - FENCE_OPEN.length, start) === FENCE_OPEN &&
    text.slice(end, end + FENCE_CLOSE.length) === FENCE_CLOSE
  ) {
    return unwrap(at, FENCE_OPEN.length, true);
  }
  if (
    sel.length >= FENCE_OPEN.length + FENCE_CLOSE.length &&
    sel.startsWith(FENCE_OPEN) &&
    sel.endsWith(FENCE_CLOSE)
  ) {
    return unwrap(at, FENCE_OPEN.length, false);
  }
  const where = marked(at, "`", (run) => run === 1);
  if (where) {
    return unwrap(at, 1, where === "outside");
  }
  return start === end || sel.includes("\n")
    ? wrap(at, FENCE_OPEN, FENCE_CLOSE, "code")
    : wrap(at, "`", "`", "code");
}

// --- markers at the start of each selected line ---

/** Rewrites every line the selection touches, whole, and selects the rewritten lines. A
 *  selection that ends just after a line break (a triple-click) stops at that line. */
function eachLine(at: TextSelection, rewrite: (lines: string[]) => string[]): FormatEdit {
  const { text } = at;
  const start = text.lastIndexOf("\n", at.start - 1) + 1;
  const last = at.end > at.start && text[at.end - 1] === "\n" ? at.end - 1 : at.end;
  const lineEnd = text.indexOf("\n", last);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const insert = rewrite(text.slice(start, end).split("\n")).join("\n");
  return { start, end, insert, select: { start, end: start + insert.length } };
}

/** The lines a marker applies to: those with text, or every line when all are blank (a
 *  marker on an empty line is where the publisher starts typing). */
function targets(lines: string[]): (line: string) => boolean {
  const any = lines.some((l) => l.trim() !== "");
  return (l) => !any || l.trim() !== "";
}

const HEADING = /^#{1,6} /;

/** A heading of any level comes off; anything else becomes a `##` heading. */
function toggleHeading(at: TextSelection): FormatEdit {
  return eachLine(at, (lines) => {
    const on = targets(lines);
    const all = lines.filter(on).every((l) => HEADING.test(l));
    return lines.map((l) =>
      !on(l) ? l : all ? l.replace(HEADING, "") : `## ${l.replace(HEADING, "")}`,
    );
  });
}

const QUOTE = /^> ?/;

/** Quotes every line, blank ones too so the quote runs on across paragraphs, unless every line
 *  with text already is a quote, when the quote comes off. */
function toggleQuote(at: TextSelection): FormatEdit {
  return eachLine(at, (lines) => {
    const on = targets(lines);
    const all = lines.filter(on).every((l) => QUOTE.test(l));
    return lines.map((l) => (all ? l.replace(QUOTE, "") : QUOTE.test(l) ? l : `> ${l}`));
  });
}

const LIST_ITEM = /^(\s*)(?:([-*+])|\d+[.)]) /;

/** Makes the lines a bulleted or numbered list, numbered in order, keeping each line's
 *  indentation. A line that is already the other kind of item switches; lines that are all
 *  this kind already stop being a list. */
function toggleList(at: TextSelection, kind: "ul" | "ol"): FormatEdit {
  const isKind = (l: string) => {
    const m = LIST_ITEM.exec(l);
    return m !== null && (m[2] !== undefined) === (kind === "ul");
  };
  return eachLine(at, (lines) => {
    const on = targets(lines);
    const all = lines.filter(on).every(isKind);
    let n = 0;
    return lines.map((l) => {
      if (!on(l)) {
        return l;
      }
      const m = LIST_ITEM.exec(l);
      const indent = m ? (m[1] ?? "") : (/^\s*/.exec(l)?.[0] ?? "");
      const rest = l.slice(m ? m[0].length : indent.length);
      if (all) {
        return indent + rest;
      }
      n += 1;
      return `${indent}${kind === "ul" ? "-" : `${n}.`} ${rest}`;
    });
  });
}
