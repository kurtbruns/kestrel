import { describe, expect, it } from "vitest";
import { inlineStack, SANS_STACK, SERIF_STACK, serifStacksNamed } from "./fonts";

describe("the app's font stacks", () => {
  it("name only fonts a reader already has, with a generic family last", () => {
    expect(SERIF_STACK).toBe("Georgia, 'Times New Roman', serif");
    expect(SANS_STACK.endsWith(", sans-serif")).toBe(true);
  });

  it("are spelled inline with no space after a comma, the same families in the same order", () => {
    expect(inlineStack(SERIF_STACK)).toBe("Georgia,'Times New Roman',serif");
  });
});

describe("finding the serif stacks a surface names", () => {
  it("reads a stack in a declaration, a shorthand, an inline style, and a custom property, however it's spelled", () => {
    const text = [
      `.a { font-family: Georgia, 'Times New Roman', serif; }`,
      `.b { font: 600 17px/1.2 Georgia, "Times New Roman", serif; }`,
      `<div style="font:600 22px/1.2 Georgia,'Times New Roman',serif;color:red">`,
      `:root { --r-serif:Georgia, 'Times New Roman', serif; }`,
      `<a style="font-family:Georgia, &#39;Times New Roman&#39;, serif;">`,
    ].join("\n");
    expect(serifStacksNamed(text)).toEqual(Array(5).fill(SERIF_STACK));
  });

  it("catches a stack with another face in front, or a different face altogether", () => {
    expect(
      serifStacksNamed(
        `:root{--r-serif:Fraunces,Georgia,'Iowan Old Style','Times New Roman',serif;}` +
          `h1{font-family:'Playfair Display', serif}`,
      ),
    ).toEqual([
      "Fraunces, Georgia, 'Iowan Old Style', 'Times New Roman', serif",
      "'Playfair Display', serif",
    ]);
  });

  it("leaves out the sans, a custom property's name, and a comment", () => {
    expect(
      serifStacksNamed(
        `body{font-family:${SANS_STACK};font:600 1px var(--serif)} /* a serif, Georgia */ <!-- serif -->`,
      ),
    ).toEqual([]);
  });
});
