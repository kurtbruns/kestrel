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
    expect(placeholderFor("owl.png", "", new Set())).toBe('<!-- Uploading "owl.png"… -->');
  });

  it("numbers a second upload of a name already uploading, so each finds its own", () => {
    const text = '<!-- Uploading "owl.png"… -->\n<!-- Uploading "owl.png" (2)… -->';
    expect(placeholderFor("owl.png", text, new Set())).toBe('<!-- Uploading "owl.png" (3)… -->');
  });

  it("numbers past an upload still out whose line has left the text, so a later one can't take its place", () => {
    const out = new Set(['<!-- Uploading "image.png"… -->']); // undo took its line out
    expect(placeholderFor("image.png", "", out)).toBe('<!-- Uploading "image.png" (2)… -->');
  });

  it("drops the characters that could end the comment or its quotes", () => {
    expect(placeholderFor('a "b" -->c<.png', "", new Set())).toBe(
      '<!-- Uploading "a b -c.png"… -->',
    );
  });
});

/** The text and selection an edit leaves, as the textarea would hold them. */
function applied(state: TextState, edit: TextEdit | null): TextState | null {
  return edit && { text: applyEdit(state.text, edit), ...edit.select };
}

describe("insertPlaceholder", () => {
  const placed = (text: string, at: number) => {
    const state = { text, start: at, end: at };
    const { edit } = insertPlaceholder(state, "P");
    const out = applyEdit(text, edit);
    return `${out.slice(0, edit.select.start)}|${out.slice(edit.select.start)}`;
  };

  it("makes the placeholder a paragraph of its own, the caret past the blank line after it", () => {
    expect(placed("ab", 1)).toBe("a\n\nP\n\n|b"); // mid-line: a blank line on each side
    expect(placed("First.\n\nSecond.", 8)).toBe("First.\n\nP\n\n|Second."); // at a paragraph's start
    expect(placed("First.\n\nSecond.", 6)).toBe("First.\n\nP\n\n|Second."); // at a paragraph's end
    expect(placed("First.\nSecond.", 7)).toBe("First.\n\nP\n\n|Second."); // one line break there already
  });

  it("adds no blank line above a placeholder that starts the text", () => {
    expect(placed("", 0)).toBe("P\n\n|");
    expect(placed("# Owls", 0)).toBe("P\n\n|# Owls");
    expect(placed("\n# Owls", 1)).toBe("\nP\n\n|# Owls");
  });

  it("says which line breaks it added, for a failed upload to take back", () => {
    expect(insertPlaceholder({ text: "ab", start: 1, end: 1 }, "P").pad).toEqual({
      before: 2,
      after: 2,
    });
    expect(insertPlaceholder({ text: "a\n\nb", start: 3, end: 3 }, "P").pad).toEqual({
      before: 0,
      after: 2,
    });
  });

  it("keeps two images dropped at once in the order they were dropped", () => {
    const empty = { text: "", start: 0, end: 0 };
    const first = applied(empty, insertPlaceholder(empty, "A").edit)!;
    expect(applied(first, insertPlaceholder(first, "B").edit)!.text).toBe("A\n\nB\n\n");
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
    for (const [text, at] of [
      ["# Owls\nSome text", 7],
      ["ab", 1],
      ["First.\n\nSecond.", 8],
      ["", 0],
    ] as const) {
      const before = { text, start: at, end: at };
      const { edit, pad } = insertPlaceholder(before, "PH");
      const inserted = applied(before, edit)!;
      expect(applied(inserted, replacePlaceholder(inserted, "PH", "", pad))).toEqual(before);
    }
  });

  it("answers null when the publisher deleted the placeholder, so nothing is put anywhere", () => {
    expect(replacePlaceholder({ text: "gone", start: 0, end: 0 }, "PH", "![x](x)")).toBe(null);
  });
});
