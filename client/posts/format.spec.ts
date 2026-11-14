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
    ["italic", "# «Owls»", "# *«Owls»*"],
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
    ["italic", "*«Owls»*", "«Owls»"],
    ["italic", "«*Owls*»", "«Owls»"],
    ["code", "`«hoot»`", "«hoot»"],
    ["code", "«`hoot`»", "«hoot»"],
    ["code", "«```\nx\n```»", "«x»"],
  ])(
    "%s takes its marks off whether they sit around the selection or inside it: %j",
    (kind, before, after) => {
      expect(click(kind, before)).toBe(after);
    },
  );

  it.each([
    // Italic inside bold adds italic rather than taking a star from the bold, and back.
    ["italic", "**«Owls»**", "***«Owls»***"],
    ["bold", "*«Owls»*", "***«Owls»***"],
    ["italic", "***«Owls»***", "**«Owls»**"],
    ["bold", "***«Owls»***", "*«Owls»*"],
    // Inline code beside a fence isn't the fence's.
    ["code", "```\n«x»\n```", "«x»"],
    // Asterisks alone aren't a wrapped word.
    ["bold", "«****»", "**«****»**"],
  ])(
    "bold and italic share the asterisk without taking each other's: %s on %j",
    (kind, before, after) => {
      expect(click(kind, before)).toBe(after);
    },
  );

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

  it("marks the whole line the caret or selection touches, and stops at a line a triple-click ends on", () => {
    expect(click("ul", "first\nsec«»ond\nthird")).toBe("first\n«- second»\nthird");
    expect(click("quote", "«first\n»second")).toBe("«> first»\nsecond");
  });

  it("refuses a kind the toolbar has no button for", () => {
    expect(formatEdit("strike", { text: "x", start: 0, end: 1 })).toBeNull();
  });
});
