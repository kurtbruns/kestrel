import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "../src/render/sanitize";

describe("sanitizeEmailHtml (hygiene pass)", () => {
  it("drops <script> and <style> blocks", () => {
    const out = sanitizeEmailHtml("<p>hi</p><script>alert(1)</script><style>*{x}</style>");
    expect(out).toBe("<p>hi</p>");
  });

  it("drops <meta>, <base>, and <form> tags, which act on the page, keeping the content", () => {
    const out = sanitizeEmailHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">' +
        '<form method="post" action="/posts/p1/schedule"><p>Keep reading</p><button>Go</button></FORM>',
    );
    expect(out).toBe("<p>Keep reading</p><button>Go</button>");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeEmailHtml('<img src="x.png" onerror="steal()" alt="a">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('src="x.png"');
  });

  it("neutralizes javascript: / vbscript: URLs", () => {
    const out = sanitizeEmailHtml(
      '<a href="javascript:evil()">x</a><a href="vbscript:bad()">y</a>',
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/vbscript:/i);
    expect(out).toContain("unsafe:");
  });

  it("leaves ordinary content untouched", () => {
    const html =
      '<h1>Title</h1><p>Body with <a href="https://ok.com">a link</a> and <strong>bold</strong>.</p>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });
});
