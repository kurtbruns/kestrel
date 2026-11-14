import { describe, expect, it } from "vitest";
import { formatEdit } from "./format";

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

  it("leaves a link alone on a second click, since taking it apart would lose its address", () => {
    expect(twice("link", "«owls»")).toBe("[[«owls»](https://)](https://)");
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
