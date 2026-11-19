import { describe, expect, it } from "vitest";
import { imageAddress, imageTargetAt, imageUsedIn, insertImage, sizeText } from "./images";
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

describe("imageTargetAt", () => {
  const text = 'Intro.\n\n![A barn owl](barn.png "Barn")\n\n[a link](page.html)';
  it.each([
    ["its !", text.indexOf("!")],
    ["its alt text", text.indexOf("barn owl")],
    ["its target", text.indexOf("barn.png")],
    ["its closing parenthesis", text.indexOf('")') + 2],
  ])("finds the image a click on %s lands on", (_, at) => {
    expect(imageTargetAt(text, at)).toBe("barn.png");
  });

  it.each([
    ["plain text", text.indexOf("Intro")],
    ["a link, which isn't an image", text.indexOf("page.html")],
  ])("finds none on %s", (_, at) => {
    expect(imageTargetAt(text, at)).toBe(null);
  });

  it("takes a target written in angle brackets without them", () => {
    expect(imageTargetAt("![x](<My Cover.png>)", 3)).toBe("My Cover.png");
  });
});

describe("imageAddress", () => {
  const base = "https://media.example.com";
  it("puts a name under this post's images", () => {
    expect(imageAddress("barn.png", base, "p1")).toBe(
      "https://media.example.com/posts/p1/barn.png",
    );
  });

  it("encodes a name once, however it was written", () => {
    expect(imageAddress("My%20Cover.png", base, "p1")).toBe(
      "https://media.example.com/posts/p1/My%20Cover.png",
    );
    expect(imageAddress("My Cover.png", base, "p1")).toBe(
      "https://media.example.com/posts/p1/My%20Cover.png",
    );
  });

  it("opens a web address as written", () => {
    expect(imageAddress("https://elsewhere.example/owl.jpg", base, "p1")).toBe(
      "https://elsewhere.example/owl.jpg",
    );
  });

  it.each(["javascript:alert(1)", "data:image/png;base64,AAAA"])("opens nothing for %s", (t) => {
    expect(imageAddress(t, base, "p1")).toBe(null);
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
