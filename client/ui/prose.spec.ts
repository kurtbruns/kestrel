import { describe, expect, it } from "vitest";
import { setHtml } from "./html";
import { inline, prose } from "./prose";

/** Render markup into a fresh element and read it back. */
function render(markup: Parameters<typeof setHtml>[1]): HTMLElement {
  const el = document.createElement("div");
  setHtml(el, markup);
  return el;
}

describe("inline Markdown in the API reference's prose", () => {
  it("renders code spans, bold, and links as elements, and the rest as text", () => {
    const el = render(
      inline("Pass `since` from **any** read; see [the guide](https://example.com/guide)."),
    );
    expect(el.innerHTML).toBe(
      'Pass <code>since</code> from <strong>any</strong> read; see <a href="https://example.com/guide">the guide</a>.',
    );
  });

  it("never makes an element from the source's own HTML, inside a code span or out of one", () => {
    const el = render(inline("A <b>tag</b> and `<script>alert(1)</script>`"));
    expect(el.querySelector("b, script")).toBeNull();
    expect(el.textContent).toBe("A <b>tag</b> and <script>alert(1)</script>");
  });

  it("keeps a link's target only for a web address or a path on this origin", () => {
    const hrefs = (src: string) =>
      [...render(inline(src)).querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(
      hrefs("[a](https://x.example) [b](/api/sends) [c](//evil.example) [d](/\\evil.example)"),
    ).toEqual(["https://x.example", "/api/sends"]);
    const el = render(inline("[run](javascript:void0) and [jump](#the-send-view)"));
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("run and jump");
  });

  it("splits paragraphs at blank lines", () => {
    const el = render(prose("One `a`.\n\nTwo.\n\n\n", "p"));
    expect([...el.querySelectorAll("p.p")].map((p) => p.innerHTML)).toEqual([
      "One <code>a</code>.",
      "Two.",
    ]);
  });
});
