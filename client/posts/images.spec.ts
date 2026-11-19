import { describe, expect, it } from "vitest";
import { imageUsedIn, insertImage, sizeText } from "./images";
import { applyEdit } from "./uploads";

describe("imageUsedIn", () => {
  it.each([
    ["a Markdown image", "Before.\n\n![The harbour](harbour.jpg)\n\nAfter."],
    ["a reference definition", "![The harbour][h]\n\n[h]: harbour.jpg"],
    ["a link", "[See it large](harbour.jpg)"],
    ["its full address", "![x](https://news.example.com/media/posts/p_1/harbour.jpg)"],
    ["raw HTML", '<img src="https://news.example.com/media/posts/p_1/harbour.jpg" alt="">'],
    ["a mention in prose, which errs toward keeping it", "The photo, harbour.jpg, is mine."],
  ])("finds the image used by %s", (_, body) => {
    expect(imageUsedIn(body, "harbour.jpg")).toBe(true);
  });

  it("finds an older name with a space, referenced percent-encoded", () => {
    expect(imageUsedIn("![x](My%20Cover.png)", "My Cover.png")).toBe(true);
  });

  it("finds a name with an ampersand written as raw HTML writes it", () => {
    expect(imageUsedIn('<img src="/media/posts/p_1/salt&amp;pepper.png">', "salt&pepper.png")).toBe(
      true,
    );
  });

  it.each([
    ["inside a longer name", "![x](sitemap.png)"],
    ["after a dot in a longer name", "![x](old.map.png)"],
    ["before more of a name", "![x](map.png.bak)"],
    ["with a suffix the upload numbered", "![x](map-2.png)"],
    ["nowhere", "No pictures today."],
  ])("doesn't find map.png %s", (_, body) => {
    expect(imageUsedIn(body, "map.png")).toBe(false);
  });

  it("counts a name that ends a sentence", () => {
    expect(imageUsedIn("I swapped it for map.png.", "map.png")).toBe(true);
  });
});

describe("insertImage", () => {
  it("puts the image in as a paragraph of its own and selects its alt text", () => {
    const text = "First paragraph.\nSecond line.";
    const edit = insertImage({ text, start: 16, end: 16 }, "IMG_2041.jpg");
    const after = applyEdit(text, edit);
    expect(after).toBe("First paragraph.\n\n![IMG_2041.jpg](IMG_2041.jpg)\n\nSecond line.");
    expect(after.slice(edit.select.start, edit.select.end)).toBe("IMG_2041.jpg");
  });

  it("puts it at the start of an empty body with no blank line before it", () => {
    const edit = insertImage({ text: "", start: 0, end: 0 }, "a.png");
    expect(applyEdit("", edit)).toBe("![a.png](a.png)\n\n");
    expect(edit.select).toEqual({ start: 2, end: 7 });
  });
});

describe("sizeText", () => {
  it.each([
    [820, "820 bytes"],
    [421_888, "412 KB"],
    [1_992_294, "1.9 MB"],
  ])("says %i as %s", (bytes, said) => {
    expect(sizeText(bytes)).toBe(said);
  });
});
