import { describe, expect, it } from "vitest";
import { MAX_POST_IMAGE_BYTES } from "../../shared/images";
import {
  applyEdit,
  insertPlaceholder,
  placeholderFor,
  replacePlaceholder,
  type TextEdit,
  type TextState,
  uploadRefusal,
} from "./uploads";

function fileOf(name: string, type: string, size: number): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("uploadRefusal", () => {
  it("lets a raster image at the limit go up", () => {
    expect(uploadRefusal(fileOf("owl.png", "image/png", MAX_POST_IMAGE_BYTES))).toBe(null);
  });

  it("refuses an image over the limit before sending it, in the server's words", () => {
    expect(uploadRefusal(fileOf("big.jpg", "image/jpeg", 7.5 * 1024 * 1024))).toBe(
      "“big.jpg” is 7.5 MB. An image must be 5 MB or smaller.",
    );
  });

  it.each([
    ["notes.pdf", "application/pdf"],
    ["logo.svg", "image/svg+xml"],
    ["photo.heic", "image/heic"],
    ["untyped", ""],
  ])("refuses %s (%s), which the server would refuse too", (name, type) => {
    expect(uploadRefusal(fileOf(name, type, 10))).toBe(
      `“${name}” isn’t an image Kestrel can add. An image must be a PNG, JPEG, WebP, or GIF.`,
    );
  });
});

describe("placeholderFor", () => {
  it("names the file being uploaded", () => {
    expect(placeholderFor("owl.png", "")).toBe('<!-- Uploading "owl.png"… -->');
  });

  it("numbers a second upload of a name already uploading, so each finds its own", () => {
    const text = '<!-- Uploading "owl.png"… -->\n<!-- Uploading "owl.png" (2)… -->';
    expect(placeholderFor("owl.png", text)).toBe('<!-- Uploading "owl.png" (3)… -->');
  });

  it("drops the characters that could end the comment or its quotes", () => {
    expect(placeholderFor('a "b" -->c<.png', "")).toBe('<!-- Uploading "a b -c.png"… -->');
  });
});

/** The text and selection an edit leaves, as the textarea would hold them. */
function applied(state: TextState, edit: TextEdit | null): TextState | null {
  return edit && { text: applyEdit(state.text, edit), ...edit.select };
}

describe("insertPlaceholder", () => {
  it("puts the placeholder on its own line at the caret, and the caret after it", () => {
    const edit = insertPlaceholder({ text: "ab", start: 1, end: 1 }, "P");
    expect(edit).toEqual({ from: 1, to: 1, text: "\nP\n", select: { start: 4, end: 4 } });
  });

  it("keeps two images dropped at once in the order they were dropped", () => {
    const empty = { text: "", start: 0, end: 0 };
    const first = applied(empty, insertPlaceholder(empty, "A"))!;
    expect(applied(first, insertPlaceholder(first, "B"))!.text).toBe("\nA\n\nB\n");
  });
});

describe("replacePlaceholder", () => {
  it("swaps only the placeholder, where it now is, after text typed above it", () => {
    const text = 'typed since\n\n<!-- Uploading "owl.png"… -->\nafter';
    const state = { text, start: text.length, end: text.length }; // typing at the end
    const edit = replacePlaceholder(state, '<!-- Uploading "owl.png"… -->', "![owl.png](owl.png)");
    expect(edit).toEqual({
      from: 13,
      to: 13 + '<!-- Uploading "owl.png"… -->'.length,
      text: "![owl.png](owl.png)",
      select: { start: 38, end: 38 }, // the caret stays at the end of the text
    });
    expect(applied(state, edit)!.text).toBe("typed since\n\n![owl.png](owl.png)\nafter");
  });

  it("leaves a caret above the placeholder where it was", () => {
    const edit = replacePlaceholder({ text: "ab\nPH\n", start: 1, end: 1 }, "PH", "![x](x)");
    expect(edit?.select).toEqual({ start: 1, end: 1 });
  });

  it("removes a failed upload's placeholder and the line breaks it brought, leaving the text as it was", () => {
    const before = { text: "# Owls\nSome text", start: 7, end: 7 };
    const inserted = applied(before, insertPlaceholder(before, "PH"))!;
    expect(applied(inserted, replacePlaceholder(inserted, "PH", ""))).toEqual(before);
  });

  it("answers null when the publisher deleted the placeholder, so nothing is put anywhere", () => {
    expect(replacePlaceholder({ text: "gone", start: 0, end: 0 }, "PH", "![x](x)")).toBe(null);
  });
});
