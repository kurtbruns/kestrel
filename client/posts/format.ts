// What each formatting toolbar button does to the post body's text: given the text and the
// selection, the one span to replace and what to select after. A button toggles: on text that
// already carries its markup it takes the markup off, so a second click undoes the first
// instead of stacking marks. Link and Indent are the exceptions: taking a link apart would
// throw away its address, and stacking an indent is how a list nests. Pure, so the view only
// applies the edit (posts/text_edit.ts), as one step the browser can undo.
//
// Bold, Italic, and Code act on the words, not on exactly what was selected: spaces at the ends
// of a selection stay outside the marks (a double-click often takes the space after a word, and
// `** word **` marks nothing), and a caret inside a word stands for that word.

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

/**
 * What an inline mark goes around: the selection without the `space` at its ends, or the word
 * a bare caret sits inside. A selection of nothing but space, and a caret at a word's edge or
 * outside one, are left as they are, so the button still inserts its placeholder there.
 */
function words(at: TextSelection, space: RegExp): TextSelection {
  const { text } = at;
  let { start, end } = at;
  if (start === end) {
    if (!isWord(text[start - 1]) || !isWord(text[start])) {
      return at;
    }
    while (isWord(text[start - 1])) {
      start -= 1;
    }
    while (isWord(text[end])) {
      end += 1;
    }
    return { text, start, end };
  }
  while (start < end && space.test(text[start] ?? "")) {
    start += 1;
  }
  while (end > start && space.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  return start === end ? at : { text, start, end };
}

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

/** Takes `left` characters off before and `right` after: around the selection (`outside`), or
 *  off the selected text's two ends. What they enclosed is left selected. */
function unwrap(at: TextSelection, left: number, right: number, outside: boolean): FormatEdit {
  const start = outside ? at.start - left : at.start;
  const end = outside ? at.end + right : at.end;
  const inner = outside
    ? at.text.slice(at.start, at.end)
    : at.text.slice(at.start + left, at.end - right);
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

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * A kind of inline mark: the character its runs are made of, which pair of runs (before, after)
 * makes one, and which runs between them would be the same mark again. Bold is a run of two
 * and italic a run of one, of `*` or `_`; a run of three is both. Code is a run of backticks
 * of any length, closed by one as long.
 */
interface Mark {
  ch: string;
  pairs: (before: number, after: number) => boolean;
  same: (run: number, before: number) => boolean;
  /** How much of a run comes off: its own marks, so Italic leaves `***`'s bold behind. */
  take: (run: number) => number;
}

function emphasis(ch: string, size: 1 | 2): Mark {
  const is = (run: number) => run === size || run === 3;
  return { ch, pairs: (b, a) => is(b) && is(a), same: is, take: () => size };
}
const CODE: Mark = {
  ch: "`",
  pairs: (b, a) => b >= 1 && b === a,
  same: (run, b) => run === b,
  take: (run) => run,
};

/** The runs of `ch` in `text[from, to)` that can mark anything: not escaped with a backslash,
 *  and for `_`, not inside a word, where CommonMark leaves it literal (snake_case). */
function runsIn(text: string, from: number, to: number, ch: string): number[] {
  const found: number[] = [];
  let i = from;
  while (i < to) {
    if (text[i] !== ch) {
      i += 1;
      continue;
    }
    let len = 1;
    while (i + len < to && text[i + len] === ch) {
      len += 1;
    }
    const escaped = text[i - 1] === "\\";
    const intraword = ch === "_" && isWord(text[i - 1]) && isWord(text[i + len]);
    if (!escaped && !intraword) {
      found.push(len);
    }
    i += len;
  }
  return found;
}

/**
 * Whether runs at `open` and `close` (each `before`/`after` long) mark one span around
 * `[from, to)`: the first opens a span rather than closing an earlier one (an even number of the
 * same mark comes before it in its paragraph, so `**a**«b»**c**` doesn't reach into its
 * neighbours), and nothing between them is the same mark again (so `«**a** and **b**»` is two
 * spans, not one).
 */
function oneSpan(
  text: string,
  mark: Mark,
  open: number,
  from: number,
  to: number,
  close: number,
): boolean {
  const before = from - open;
  if (text[open - 1] === "\\") {
    return false;
  }
  if (mark.ch === "_" && (isWord(text[open - 1]) || isWord(text[close]))) {
    return false;
  }
  const para = text.lastIndexOf("\n\n", open - 1);
  const earlier = runsIn(text, para === -1 ? 0 : para + 2, open, mark.ch);
  return (
    earlier.filter((run) => mark.same(run, before)).length % 2 === 0 &&
    !runsIn(text, from, to, mark.ch).some((run) => mark.same(run, before))
  );
}

/** The mark's runs around the selection, or at its two ends, when they make one span. */
function marked(at: TextSelection, mark: Mark): FormatEdit | null {
  const { text, start, end } = at;
  const before = runBefore(text, start, mark.ch);
  const after = runAfter(text, end, mark.ch);
  if (mark.pairs(before, after) && oneSpan(text, mark, start - before, start, end, end + after)) {
    return unwrap(at, mark.take(before), mark.take(after), true);
  }
  const sel = text.slice(start, end);
  const lead = runAfter(sel, 0, mark.ch);
  const trail = runBefore(sel, sel.length, mark.ch);
  // Something has to sit between the marks: a selection of nothing but asterisks isn't wrapped.
  if (
    lead + trail < sel.length &&
    mark.pairs(lead, trail) &&
    oneSpan(text, mark, start, start + lead, end - trail, end)
  ) {
    return unwrap(at, mark.take(lead), mark.take(trail), false);
  }
  return null;
}

/** Bold or italic, off if the selection is one span of it in either character, else on. Bold
 *  adds `**`; italic adds `_`, or `*` where it touches a word, since CommonMark leaves an
 *  underscore inside a word literal (un*believ*able is emphasis, un_believ_able is not). */
function toggleEmphasis(selected: TextSelection, size: 1 | 2, placeholder: string): FormatEdit {
  // Line breaks come off the ends too: a mark can't reach across one to close.
  const at = words(selected, /\s/);
  for (const ch of size === 1 ? ["_", "*"] : ["*", "_"]) {
    const off = marked(at, emphasis(ch, size)) ?? throughOther(at, ch, emphasis(ch, size));
    if (off) {
      return off;
    }
  }
  const { text } = at;
  let before = at.start;
  while (before > 0 && EMPHASIS.includes(text[before - 1] ?? "")) {
    before -= 1;
  }
  let after = at.end;
  while (after < text.length && EMPHASIS.includes(text[after] ?? "")) {
    after += 1;
  }
  const touchesWord = isWord(text[before - 1]) || isWord(text[after]);
  const mark = (size === 2 || touchesWord ? "*" : "_").repeat(size);
  return wrap(at, mark, mark, placeholder);
}

const EMPHASIS = "*_";

/** The mark one layer out, past the other emphasis character's runs right around the
 *  selection: Bold on the words of `**_word_**` finds the bold outside the italic, and takes it
 *  off without touching the italic or the selection. */
function throughOther(at: TextSelection, ch: string, mark: Mark): FormatEdit | null {
  const other = ch === "*" ? "_" : "*";
  const k = Math.min(runBefore(at.text, at.start, other), runAfter(at.text, at.end, other));
  if (k === 0) {
    return null;
  }
  const off = marked({ text: at.text, start: at.start - k, end: at.end + k }, mark);
  if (!off) {
    return null;
  }
  return { ...off, select: { start: off.select.start + k, end: off.select.end - k } };
}

const FENCE_LINE = /^```[^`\n]*$/; // an opening fence, with its language if it names one
const FENCE_CLOSE = "\n```";

/** A fenced block whose fences sit right around the selection, or at its two ends. */
function fenced(at: TextSelection): FormatEdit | null {
  const { text, start, end } = at;
  const closes = (i: number) =>
    text.startsWith(FENCE_CLOSE, i) &&
    (i + FENCE_CLOSE.length === text.length || text[i + FENCE_CLOSE.length] === "\n");
  if (start > 0 && text[start - 1] === "\n" && closes(end)) {
    const lineStart = text.lastIndexOf("\n", start - 2) + 1;
    if (FENCE_LINE.test(text.slice(lineStart, start - 1))) {
      return unwrap(at, start - lineStart, FENCE_CLOSE.length, true);
    }
  }
  const sel = text.slice(start, end);
  const open = /^```[^`\n]*\n/.exec(sel)?.[0];
  if (open && sel.length >= open.length + FENCE_CLOSE.length && sel.endsWith(FENCE_CLOSE)) {
    return unwrap(at, open.length, FENCE_CLOSE.length, false);
  }
  return null;
}

/** Inline code for a selection within a line, a fenced block for none or several lines; either
 *  comes off again on a second click, a fence with a language or a span of longer backtick
 *  runs (``a`b``) included. */
function toggleCode(selected: TextSelection): FormatEdit {
  // Only spaces and tabs come off: a selection ending in a line break is whole lines, which
  // fence as they were selected.
  const at = words(selected, /[ \t]/);
  const off = fenced(at) ?? marked(at, CODE);
  if (off) {
    return off;
  }
  const sel = at.text.slice(at.start, at.end);
  return at.start === at.end || sel.includes("\n")
    ? wrap(at, "```\n", FENCE_CLOSE, "code")
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
 *  indentation. The button acts on the outermost lines selected: an item nested under them keeps
 *  its own marker and number. An outer line that is already the other kind of item switches;
 *  outer lines that are all this kind already stop being a list. */
function toggleList(at: TextSelection, kind: "ul" | "ol"): FormatEdit {
  const isKind = (l: string) => {
    const m = LIST_ITEM.exec(l);
    return m !== null && (m[2] !== undefined) === (kind === "ul");
  };
  const depth = (l: string) => /^\s*/.exec(l)?.[0].length ?? 0;
  return eachLine(at, (lines) => {
    const on = targets(lines);
    const outer = Math.min(...lines.filter(on).map(depth));
    const top = (l: string) => on(l) && depth(l) === outer;
    const all = lines.filter(top).every(isKind);
    let n = 0;
    return lines.map((l) => {
      if (!top(l)) {
        return l;
      }
      const m = LIST_ITEM.exec(l);
      const indent = l.slice(0, outer);
      const rest = l.slice(m ? m[0].length : outer);
      if (all) {
        return indent + rest;
      }
      n += 1;
      return `${indent}${kind === "ul" ? "-" : `${n}.`} ${rest}`;
    });
  });
}
