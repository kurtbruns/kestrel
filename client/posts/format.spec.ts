import { describe, expect, it } from "vitest";
import { formatEdit, linkAddress } from "./format";

// The body and its selection written as one string, the selection between « and », so a case
// reads as the text before and after a click.
function click(kind: string, marked: string): string {
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  const text = marked.replace("«", "").replace("»", "");
  const edit = formatEdit(kind, { text, start, end });
  if (!edit) {
    throw new Error(`no edit for ${kind}`);
  }
  const next = text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
  return `${next.slice(0, edit.select.start)}«${next.slice(edit.select.start, edit.select.end)}»${next.slice(edit.select.end)}`;
}
function twice(kind: string, marked: string): string {
  return click(kind, click(kind, marked));
}

describe("toolbar formatting", () => {
  it.each([
    ["bold", "# «Owls»", "# **«Owls»**"],
    ["italic", "# «Owls»", "# _«Owls»_"],
    // Inside a word an underscore stays literal in CommonMark, so italic takes an asterisk.
    ["italic", "un«believ»able", "un*«believ»*able"],
    ["italic", "word«»", "word*«italic text»*"],
    ["code", "say «hoot» twice", "say `«hoot»` twice"],
    ["bold", "«»", "**«bold text»**"],
    ["code", "«»", "```\n«code»\n```"],
    ["code", "«a\nb»", "```\n«a\nb»\n```"],
  ])("%s wraps the selection and leaves the words selected: %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it.each([
    // A double-click often takes the space after a word, and `** word **` marks nothing.
    ["bold", "alpha «beta »gamma", "alpha **«beta»** gamma"],
    ["bold", "alpha« beta »gamma", "alpha **«beta»** gamma"],
    ["italic", "alpha «beta »gamma", "alpha _«beta»_ gamma"],
    ["code", "alpha «beta »gamma", "alpha `«beta»` gamma"],
    ["bold", "«Hoot.\n»\nMore.", "**«Hoot.»**\n\nMore."], // a triple-click's line break
    ["code", "«a\n»", "```\n«a\n»\n```"], // whole lines still fence as selected
    ["bold", "alpha« »gamma", "alpha**« »**gamma"], // nothing but space: left as selected
  ])("%s keeps the space at a selection's ends outside its marks: %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it.each([
    ["bold", "alpha be«»ta gamma", "alpha **«beta»** gamma"],
    ["italic", "alpha be«»ta gamma", "alpha _«beta»_ gamma"],
    ["code", "alpha be«»ta gamma", "alpha `«beta»` gamma"],
    ["bold", "alpha **be«»ta** gamma", "alpha «beta» gamma"], // and off again from inside it
    ["bold", "alpha «»beta", "alpha **«bold text»**beta"], // at a word's edge: the placeholder
    ["bold", "alpha beta«»", "alpha beta**«bold text»**"],
    // An apostrophe between two letters is inside the word, so a contraction is one word.
    ["bold", "I do«»n't know", "I **«don't»** know"],
    ["bold", "I don'«»t know", "I **«don't»** know"],
    ["bold", "I do«»n’t know", "I **«don’t»** know"], // the curly apostrophe too
    ["italic", "I do«»n't know", "I _«don't»_ know"],
    ["code", "I do«»n't know", "I `«don't»` know"],
    ["bold", "I **do«»n't** know", "I «don't» know"],
    ["bold", "i«»t's here", "**«it's»** here"],
    // One at a word's start or end is a quote mark, and stays outside.
    ["bold", "'ti«»s true", "'**«tis»** true"],
    ["bold", "the do«»gs' bones", "the **«dogs»**' bones"],
    ["bold", "the dogs«»' bones", "the dogs**«bold text»**' bones"],
  ])("%s takes the word a bare caret is inside: %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it.each([
    ["bold", "# «Owls»"],
    ["italic", "# «Owls»"],
    ["italic", "un«believ»able"],
    ["code", "say «hoot» twice"],
    ["code", "«a\nb»"],
    ["heading", "«Owls»"],
    ["quote", "«one\ntwo»"],
    ["ul", "«one\ntwo»"],
    ["ol", "«one\ntwo»"],
  ])("a second %s click takes off what the first put on: %j", (kind, before) => {
    const words = before.replace("«", "").replace("»", "");
    expect(twice(kind, before).replace("«", "").replace("»", "")).toBe(words);
  });

  it.each([
    ["bold", "**«Owls»**", "«Owls»"],
    ["bold", "«**Owls**»", "«Owls»"],
    ["italic", "_«Owls»_", "«Owls»"],
    ["italic", "«_Owls_»", "«Owls»"],
    // Asterisk italic and underscore bold, as written by hand or by Claude, come off too.
    ["italic", "*«Owls»*", "«Owls»"],
    ["italic", "«*Owls*»", "«Owls»"],
    ["bold", "__«Owls»__", "«Owls»"],
    ["bold", "«__Owls__»", "«Owls»"],
    ["code", "`«hoot»`", "«hoot»"],
    ["code", "«`hoot`»", "«hoot»"],
    ["code", "«```\nx\n```»", "«x»"],
    // A fence that names its language, and a code span of longer backtick runs.
    ["code", "```js\n«x»\n```", "«x»"],
    ["code", "«```js\nx\n```»", "«x»"],
    ["code", "``«a`b»``", "«a`b»"],
    ["code", "«``a`b``»", "«a`b»"],
  ])(
    "%s takes its marks off whether they sit around the selection or inside it: %j",
    (kind, before, after) => {
      expect(click(kind, before)).toBe(after);
    },
  );

  it.each([
    // Italic inside bold adds underscores; bold inside italic adds asterisks; each comes off alone.
    ["italic", "**«Owls»**", "**_«Owls»_**"],
    ["bold", "_«Owls»_", "_**«Owls»**_"],
    ["bold", "**_«Owls»_**", "_«Owls»_"],
    ["italic", "**_«Owls»_**", "**«Owls»**"],
    ["bold", "*«Owls»*", "***«Owls»***"],
    // A run of three, as written by hand, is both: each button takes only its own.
    ["italic", "***«Owls»***", "**«Owls»**"],
    ["bold", "***«Owls»***", "*«Owls»*"],
    // An underscore inside a word marks nothing, so it isn't taken for italic.
    ["italic", "un_«believ»_able", "un_*«believ»*_able"],
    // Inline code beside a fence isn't the fence's.
    ["code", "```\n«x»\n```", "«x»"],
    // Asterisks alone aren't a wrapped word.
    ["bold", "«****»", "**«****»**"],
  ])(
    "bold and italic stack and come off without taking each other's marks: %s on %j",
    (kind, before, after) => {
      expect(click(kind, before)).toBe(after);
    },
  );

  it.each([
    // Two spans selected together are wrapped, never joined by taking their outer marks.
    ["bold", "«**a** and **b**»", "**«**a** and **b**»**"],
    ["bold", "**«a** and **b»**", "****«a** and **b»****"],
    ["italic", "«_a_ and _b_»", "_«_a_ and _b_»_"],
    ["italic", "«*a* and *b*»", "_«*a* and *b*»_"],
    ["code", "«`a` and `b`»", "`«`a` and `b`»`"],
    // An escaped mark is text, not a span.
    ["bold", "\\**«a»**", "\\****«a»****"],
    // Bold inside italic is still one italic span.
    ["italic", "«_a **b** c_»", "«a **b** c»"],
  ])(
    "takes marks off only when the selection is one span of them: %s on %j",
    (kind, before, after) => {
      expect(click(kind, before)).toBe(after);
    },
  );

  it.each([
    ["bold", "**a**«b»**c**", "**a****«b»****c**"],
    ["italic", "*a*«b»*c*", "*a**«b»**c*"],
    ["code", "`a` «b» `c`", "`a` `«b»` `c`"],
  ])("leaves the spans beside the selection alone: %s on %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it("links the selected words and selects the address, so a paste replaces it", () => {
    expect(click("link", "see «the owls» here")).toBe("see [the owls](«https://») here");
    expect(formatEdit("link", { text: "owls", start: 0, end: 4 })?.tabToAddress).toBeUndefined();
  });

  it.each([
    ["see «owls »here", "see [owls](«https://») here"], // a double-click's trailing space
    ["see «  owls» here", "see   [owls](«https://») here"],
    ["see o«»wls here", "see [owls](«https://») here"], // a caret in a word stands for it
    ["I do«»n't know", "I [don't](«https://») know"],
  ])("links the words, as the other marks do: %j", (before, after) => {
    expect(click("link", before)).toBe(after);
  });

  it("links at a bare caret with the text placeholder selected, and lets Tab move on", () => {
    expect(click("link", "see «»")).toBe("see [«link text»](https://)");
    expect(formatEdit("link", { text: "", start: 0, end: 0 })?.tabToAddress).toBe(true);
  });

  it("adds a link again on a second click, since taking it apart would lose its address", () => {
    expect(twice("link", "«owls»")).toBe("[owls]([https://](«https://»))");
  });

  it("indents again on each click, as nesting a list needs", () => {
    expect(twice("indent", "«- owl»")).toBe("«    - owl»");
  });

  it.each([
    ["heading", "«Owls»", "«## Owls»"],
    ["heading", "«# Owls»", "«Owls»"], // any level counts as a heading
    ["heading", "«# Owls\nHoot»", "«## Owls\n## Hoot»"], // mixed: all become headings, no "## #"
    ["heading", "«»", "«## »"], // an empty line takes the marker, to type after
    ["quote", "«one\n\ntwo»", "«> one\n> \n> two»"],
    ["quote", "«> one\n>\n> two»", "«one\n\ntwo»"],
    ["ul", "«one\n\ntwo»", "«- one\n\n- two»"], // a blank line stays blank
    ["ol", "«one\ntwo\nthree»", "«1. one\n2. two\n3. three»"],
    ["ol", "«- one\n- two»", "«1. one\n2. two»"], // the other kind of list switches
    ["ul", "«1. one\n2. two»", "«- one\n- two»"],
    ["ul", "«  one\n  - two»", "«  - one\n  - two»"], // indentation kept
    ["ol", "«  1. one\n  2. two»", "«  one\n  two»"],
    ["ul", "«* one\n+ two»", "«one\ntwo»"], // any bullet counts
  ])("%s on whole lines: %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it.each([
    // Numbered per level: items nested under the outer lines keep their own markers.
    ["ul", "«1. a\n  - b\n2. c»", "«- a\n  - b\n- c»"],
    ["ol", "«- a\n  - b\n- c»", "«1. a\n  - b\n2. c»"],
    ["ol", "«- a\n  1. x\n  2. y\n- b»", "«1. a\n  1. x\n  2. y\n2. b»"],
    ["ol", "«1. a\n  - b\n2. c»", "«a\n  - b\nc»"],
  ])("lists act on the outermost lines selected: %s on %j", (kind, before, after) => {
    expect(click(kind, before)).toBe(after);
  });

  it("marks the whole line the caret or selection touches, and stops at a line a triple-click ends on", () => {
    expect(click("ul", "first\nsec«»ond\nthird")).toBe("first\n«- second»\nthird");
    expect(click("quote", "«first\n»second")).toBe("«> first»\nsecond");
  });

  it("refuses a kind the toolbar has no button for", () => {
    expect(formatEdit("strike", { text: "x", start: 0, end: 1 })).toBeNull();
  });
});

describe("Tab from a link's text", () => {
  // A link inserted at offset 4 of "see ", its text starting at 5.
  const inserted = "see [link text](https://) more";

  it("moves to the address from the untouched placeholder", () => {
    expect(linkAddress(inserted, 5, 5, 14)).toEqual({ start: 16, end: 24 });
  });

  it("moves to the address once the text is typed over", () => {
    const typed = "see [the owls](https://) more";
    expect(linkAddress(typed, 5, 13, 13)).toEqual({ start: 15, end: 23 });
  });

  it.each([
    ["the caret moved before the text", inserted, 4, 4],
    ["the caret is mid-text", inserted, 8, 8],
    ["the caret moved past the text", inserted, 20, 20],
    ["the text was taken apart", "see link text](https://)", 5, 13],
    ["the text runs over a line", "see [link\ntext](https://)", 10, 14],
    ["the address runs over a line", "see [owls](https:\n//)", 9, 9],
    ["the address was never closed", "see [owls](https://", 9, 9],
  ])("leaves Tab alone when %s", (_why, text, start, end) => {
    expect(linkAddress(text, 5, start, end)).toBeNull();
  });
});
