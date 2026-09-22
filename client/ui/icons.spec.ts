import { describe, expect, it } from "vitest";
import { Html, html } from "./html";
import { icon, isIconName } from "./icons";

describe("icons", () => {
  it("serves each file as inline, decorative markup", () => {
    for (const name of ["bold", "check", "info", "info-filled", "kestrel", "x"] as const) {
      const m = icon(name);
      expect(m).toBeInstanceOf(Html);
      expect(m.markup).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*aria-hidden="true"/,
      );
      expect(m.markup.trimEnd()).toMatch(/<\/svg>$/);
    }
  });

  it("composes into the html tag without escaping", () => {
    expect(html`<button>${icon("x")}</button>`.markup).toMatch(/^<button><svg /);
  });

  it("names its icons", () => {
    expect(isIconName("bold")).toBe(true);
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("nope")).toBe(false);
  });
});
